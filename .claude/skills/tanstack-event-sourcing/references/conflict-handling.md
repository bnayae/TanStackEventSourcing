# Conflict Handling, OCC & Poison Pills

This reference covers how the client and server classify, recover from, and escalate sync conflicts. It is referenced from both offline-first and online-only modes — the classification taxonomy is the same; only the surface where conflicts appear differs.

## Table of Contents
1. [Conflict Classification](#conflict-classification)
2. [Sequential Batch Sync Guarantee](#sequential-batch-sync-guarantee)
3. [Recoverable Errors — Silent Retry](#recoverable-errors--silent-retry)
4. [Unrecoverable Errors — Escalate](#unrecoverable-errors--escalate)
5. [OCC Conflicts — Server-Assigned Sequence Rebase](#occ-conflicts--server-assigned-sequence-rebase)
6. [Resolution Strategies (choose per event type)](#resolution-strategies-choose-per-event-type)
7. [Poison Pill Detection](#poison-pill-detection)
8. [Investigation (Dead-Letter) Table](#investigation-dead-letter-table)
9. [Interactive Setup — Questions to Ask the User](#interactive-setup--questions-to-ask-the-user)

---

## Conflict Classification

Every failed sync attempt falls into exactly one of three buckets. The taxonomy drives routing — what the client does next depends only on the class, not the specific status code.

| Class | Examples | Who resolves | UI surface |
|---|---|---|---|
| **Transient** | Network unreachable, 5xx, 408, 429, CORS preflight blip, TLS renegotiation | Automatic retry | None unless persistent >N minutes |
| **OCC / rebase-able** | 409 sequence conflict where server holds a DIFFERENT event at the same `(aggregateId, sequenceNumber)` | Pre-configured strategy (often: ask server to assign a new seq) | Optional toast; failures escalate |
| **Unrecoverable** | 400 (schema), 401/403 (auth), 422 (business rule rejected the event permanently), poison pill, repeated OCC after N rebases | Human or explicit strategy | Blocking notice or dead-letter |

The server response MUST carry a discriminant so the client can route without guessing. Suggested envelope on any non-2xx batch response:

```ts
{
  "errorClass": "transient" | "occ" | "unrecoverable",
  "errorCode": "SEQ_CONFLICT" | "VALIDATION_FAILED" | "BUSINESS_RULE" | "AUTH" | ...,
  "accepted": string[],
  "rejected": Array<{ id: string; reason: string; serverSeq?: number }>,
  "retryAfterMs"?: number   // honored for transient class
}
```

---

## Sequential Batch Sync Guarantee

**Invariant:** at most one batch is in flight at any time across the whole SyncEngine, and batches are dispatched in a deterministic order. The next batch does not start until the current one resolves (success, rebase, or escalation).

Why: events within an aggregate are sequence-numbered; parallel POSTs can interleave and create phantom gaps. Across aggregates the order matters less for correctness but matters a lot for reasoning about retries and for user-visible "what synced first."

Implementation sketch — replace the `for (const [aggregateId, events] of byAggregate)` loop in `SyncEngine.sync()`:

```ts
// Serialize: one aggregate-batch at a time. Do NOT Promise.all.
for (const [aggregateId, events] of byAggregate) {
  const outcome = await this.syncAggregateEvents(aggregateId, events);
  if (outcome.class === 'transient') {
    // Stop the whole run; scheduleRetry will resume from pending state.
    this.scheduleRetry();
    return;
  }
  if (outcome.class === 'unrecoverable' && outcome.blocksQueue) {
    // Poison pill in this aggregate's head. Skip this aggregate only,
    // continue with other aggregates. The poisoned aggregate is parked.
    this.parkAggregate(aggregateId, outcome.reason);
    continue;
  }
  // occ: rebase already happened inside syncAggregateEvents; continue.
}
```

**Never** `Promise.all` aggregate batches. Even if they are independent per aggregate, serializing keeps backpressure sane and makes the investigation table coherent.

Within a single batch to `POST /api/events/batch`, the server MUST process events in `sequenceNumber` order and stop at the first rejection (no partial-skip). The response lists everything up to the rejection under `accepted` and the rejected one under `rejected`; any subsequent events in the batch are re-queued client-side as still `pending` and will ride the next batch.

---

## Recoverable Errors — Silent Retry

Triggers: `fetch` throws, response is 5xx, 408, 429, or server returns `errorClass: "transient"`.

Policy:
- Exponential backoff: 1s → 2s → 4s → 8s → 16s (cap 30s)
- Honor `Retry-After` / `retryAfterMs` when present
- Do not show a user notice while `retryCount < SILENT_RETRY_THRESHOLD` (default 3) **and** total elapsed time < `SILENT_RETRY_WINDOW_MS` (default 30s)
- After the threshold, surface a subtle "reconnecting…" indicator, not a modal
- Never mark events as `failed` for transient errors — keep them `pending`
- If `navigator.onLine` flips false mid-retry, cancel the schedule; the `online` listener will resume

Do not consume the retry budget on OCC or unrecoverable errors — those have their own paths.

---

## Unrecoverable Errors — Escalate

Triggers: 400, 401, 403, 422 with `errorClass: "unrecoverable"`, or OCC that exhausted the rebase budget.

Policy:
- Mark the offending event `status = 'failed'` in Dexie and copy it to the client-side investigation log (see below)
- Mirror-write to the server investigation table via `POST /api/events/dead-letter` if reachable
- Raise a blocking, dismissible notice **only** for event types the user opted into "notify" during setup. Others are silently parked and shown in an admin view.
- Unblock the queue — do not let one bad event stall every subsequent batch (see Poison Pill Detection)

---

## OCC Conflicts — Server-Assigned Sequence Rebase

OCC (optimistic concurrency control) surfaces when two clients (or the same client reconnecting after a long offline stretch) independently picked the same `sequenceNumber` for the same `aggregateId`. The server holds the first write; the second arrives as a conflict.

Three resolution modes — pick per event type during setup:

### Mode A — `rebase` (default for additive/commutative events)
Safe when applying the event later still produces a valid state. Deposits, log entries, comments.

1. Client sends event with `clientSeq = N`.
2. Server detects `(aggregateId, N)` is taken by a different event `id`.
3. Server assigns a new sequence: `serverSeq = MAX(seq WHERE aggregateId) + 1`.
4. Server inserts event with `serverSeq`, returns `{ errorClass: "occ", rejected: [{ id, serverSeq }] }`.
5. Client updates the Dexie row: `sequenceNumber := serverSeq`, `status := 'synced'`.
6. Client re-numbers any **local pending** events on that aggregate whose seq was `> N` to close the gap. Re-numbering happens inside a Dexie transaction keyed on `aggregateId`.

Requires server support: the POST handler accepts a `conflictPolicy: "rebase"` flag per event (or per aggregate, set at aggregate creation).

### Mode B — `reject-and-investigate`
Safe when the event has business meaning tied to its original position (e.g. "the 3rd withdrawal triggers a fee"). Don't silently move it.

1. Server responds 409 with `errorClass: "unrecoverable"`, includes the winning event's payload so the client/human can decide.
2. Client moves the event to the investigation table (never synced), marks it `failed`.
3. Surface a notice only if configured.

### Mode C — `append-and-override-aggregate`
Last-writer-wins on the aggregate projection, but the event log still gets both events. Use when the aggregate is a snapshot-of-truth (e.g. "current address") and order sensitivity is low.

1. Server accepts the event with a new seq (like rebase).
2. Aggregation trigger uses the event's own `createdAt` or payload metadata, not seq, to decide whether to override aggregate fields.
3. Both events remain queryable in the log — time-travel still works.

**Budget:** cap rebases per event at `MAX_REBASE_ATTEMPTS = 3`. If a rebased event collides again, treat as unrecoverable and dead-letter.

---

## Resolution Strategies (choose per event type)

During setup you will fill this table with the user, once per event type. Default to `rebase` + `silent` for append-style events; default to `reject-and-investigate` + `notify` for state-mutating business events.

| Event type | OCC policy | Unrecoverable policy | User-visible? |
|---|---|---|---|
| `FUND_DEPOSITED` | rebase | dead-letter | silent |
| `FUND_WITHDRAWN` | reject-and-investigate | dead-letter | notify |
| `ACCOUNT_RENAMED` | append-and-override | dead-letter | silent |
| `… (per user)` | … | … | … |

Store this in `packages/types/src/eventPolicies.ts` as a const map keyed by `EventType`. Both the client (SyncEngine) and server (batch handler, aggregation trigger) read from it.

---

## Poison Pill Detection

A poison pill is an event that will **never** successfully sync — e.g. payload violates a server-side schema introduced after the event was recorded, or references an aggregate the current user no longer has permission to write. Left alone, it permanently blocks every later event for that aggregate (because `sequenceNumber N+1` requires `N` to exist server-side).

Detection heuristics (client-side, in `SyncEngine`):
- Same event id has failed with the same `errorClass: "unrecoverable"` reason twice in a row → poison.
- An event is `pending` and has been retried `>= POISON_RETRY_THRESHOLD` times (default 5) across sessions — tracked via a `retryCount` column on `DBEvent` (increment on every failed attempt, persist across reloads).
- Server responded `errorClass: "unrecoverable"` with `poison: true` — the server made the call explicitly (preferred when schema evolution is centralized).

On detection:
1. Move the event to the **investigation table** (client and server).
2. Set `status = 'parked'` on the Dexie row — do not delete, do not include in balance computations.
3. **Re-number the queue:** for every subsequent pending event on the same aggregate, decrement `sequenceNumber` by 1 so the head of the queue is continuous again. Do this in a Dexie transaction, then resume sync.
4. Emit a `poison-pill-detected` app event — the UI can badge an admin view.
5. Never retry the parked event automatically. A human must reclassify it (reissue as new event, or hard-delete from investigation).

This is the only path that removes an event from the sync queue without the server having accepted it. It must be observable.

---

## Investigation (Dead-Letter) Table

Mirror tables on client and server. Same shape; the server one is authoritative for audits.

### Client (Dexie)

```ts
// apps/web/src/db/DBEventInvestigation.ts
export interface DBEventInvestigation {
  id: string;                    // same id as the original event
  aggregateId: string;
  type: EventType;
  payload: Record<string, unknown>;
  originalSequenceNumber: number;
  createdAt: number;
  parkedAt: number;
  errorClass: 'unrecoverable' | 'poison';
  errorCode: string;             // e.g. 'VALIDATION_FAILED', 'OCC_EXHAUSTED'
  errorDescription: string;      // human-readable — shown in admin UI
  category: 'schema' | 'business-rule' | 'auth' | 'occ-exhausted' | 'poison-pill' | 'other';
  attempts: number;
  lastServerResponse?: string;   // raw body snippet for forensics
}
```

Add to `AppDatabase.version(N).stores({ eventInvestigation: 'id, aggregateId, parkedAt, category' })`.

### Server (PostgreSQL)

```sql
CREATE TABLE event_investigation (
  id                     UUID PRIMARY KEY,
  aggregate_id           UUID NOT NULL,
  type                   TEXT NOT NULL,
  payload                JSONB NOT NULL,
  original_sequence_number INT NOT NULL,
  created_at             BIGINT NOT NULL,
  parked_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_class            TEXT NOT NULL CHECK (error_class IN ('unrecoverable','poison')),
  error_code             TEXT NOT NULL,
  error_description      TEXT NOT NULL,
  category               TEXT NOT NULL,
  attempts               INT NOT NULL,
  client_id              TEXT,           -- which device surfaced the pill
  raw_request            JSONB
);
CREATE INDEX event_investigation_aggregate_idx ON event_investigation (aggregate_id, parked_at DESC);
```

API:
- `POST /api/events/dead-letter` — client mirrors a local pill to server
- `GET  /api/events/dead-letter?aggregateId=…` — admin UI feed
- `POST /api/events/dead-letter/:id/resolve` — admin action: `{ action: 'discard' | 'reissue' | 'force-accept' }`

**Never** reuse the event id from the investigation table for a replacement event. Issue a new UUID with a payload field pointing back: `{ ..., replaces: <originalId> }`.

---

## Interactive Setup — Questions to Ask the User

When bootstrapping a new event-sourced app with this skill, walk the user through these questions **per event type** before writing any conflict-handling code. Don't batch — ask a small group, confirm, move on.

### Round A — detect the universe of conflicts
> "For each event type, can two users (or the same user on two devices) legitimately produce it at the same time? If yes, describe a concrete business scenario."

Use answers to decide which event types need OCC handling at all. Events that are strictly single-writer (e.g. an admin-only config change) can skip rebase and always `reject-and-investigate`.

### Round B — pick the OCC strategy per event type
> "When two copies of `<EVENT_TYPE>` race, is the later one still meaningful?
> - **Yes, it should just happen in the new order** → rebase
> - **Yes, but only after a human decides** → reject-and-investigate
> - **Only the latest matters, older one is obsolete** → append-and-override"

### Round C — set visibility
> "If `<EVENT_TYPE>` is dead-lettered, should the end user see a notice, or is it an admin-only concern?"

Record answers into the `eventPolicies` map (see Resolution Strategies). The generated SyncEngine and batch handler both read from this single source.

### Round D — set thresholds
> "How many silent retries before the user sees 'reconnecting…'? Default is 3 / 30s."
> "How many rebases before an event is declared poison? Default is 3."
> "How many total failed attempts across sessions before parking? Default is 5."

Commit the chosen numbers to `packages/types/src/syncConfig.ts`.

### Round E — investigation ownership
> "Who reviews the investigation table? Is there an admin route in-app, or does this go to an external tool (Sentry, Linear)?"

If in-app: scaffold `apps/web/src/routes/admin.investigation.tsx` with a table view + resolve actions. If external: add a webhook in `POST /api/events/dead-letter` that forwards the record.
