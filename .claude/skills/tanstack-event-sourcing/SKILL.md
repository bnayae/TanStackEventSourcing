---
name: tanstack-event-sourcing
description: "Expert guide for building full-stack event-sourced applications using TanStack Router, TanStack Query, Dexie (IndexedDB), Express, Prisma, and PostgreSQL. Use this skill when: choosing between offline-first and online-only event sourcing modes; building an event-sourced app from scratch; adding domain events or discriminated union types; designing a PostgreSQL aggregation trigger or materialized view; implementing offline-first optimistic UI with IndexedDB; wiring useLiveQuery with Dexie; setting up SyncEngine for background sync with exponential backoff; enforcing sequential batch sync (one batch at a time); handling pending vs confirmed (optimistic) state; classifying conflicts as transient vs OCC vs unrecoverable; optimistic concurrency control; OCC rebase with server-assigned sequence; append-and-override aggregate; reject-and-investigate; detecting and parking poison pills; designing an investigation or dead-letter table for parked events; interactive conflict-policy setup per event type; adding server-side aggregate snapshots; implementing snapshot-based cold-start bootstrap; accelerating cold start with snapshot bootstrap; reducing event replay cost; balance snapshot; bootstrapFromSnapshots; afterSeq; building time-travel queries to reconstruct past aggregate state; creating a time-travel UI with event navigation; time-travel; time travel; point-in-time; historical state; explaining how events flow from client write to server confirmation; debugging sequence conflicts or 409 errors; setting up the offline simulation toggle."
---

# TanStack Event Sourcing — Expert Guide

## Step 0 — Choose the Mode

Before anything else, pin down which of the two event-sourcing postures the app needs. They share the same event schema and the same server-side aggregation, but they diverge on where the event log lives and how conflicts are surfaced.

### Offline-first mode
- Event log is written to IndexedDB **first**, then replicated to the server.
- UI reads from Dexie via `useLiveQuery`; server state is a confirmation layer.
- Required when: the app must work without network, user actions cannot be lost on disconnect, optimistic UI is a product requirement.
- Implies: client-side SyncEngine with sequential batches, full conflict taxonomy (transient / OCC / unrecoverable), poison-pill handling, investigation table mirrored on both sides.

### Online-only mode
- Event log is written **only** on the server. Client sends a command (HTTP POST), server appends the event, aggregation trigger fires, server returns the new aggregate state.
- UI reads via TanStack Query against the server's aggregate endpoints. No Dexie, no SyncEngine.
- Conflicts still happen (two users racing), but they surface as a single-request response and are resolved inline.
- Required when: audit integrity demands the server be the only writer, or the device cannot be trusted with pending state.

Ask the user which mode fits, confirm, then follow the corresponding track below.

---

## Event Flow — Offline-first

```
[User action]
    │
    ▼
addEvent() → Dexie IndexedDB (status=pending)
    │                  │
    │                  ▼
    │      useLiveQuery → React re-render (optimistic UI immediately)
    │
    ▼ (background, SyncEngine — ONE batch at a time, in order)
POST /api/events/batch
    │
    ▼
Prisma INSERT → PG trigger fires → aggregate table updated
    │
    ▼
markEventSynced() → Dexie status=synced → confirmed UI
```

## Event Flow — Online-only

```
[User action]
    │
    ▼
POST /api/events  (command, not an event yet)
    │
    ▼
Server validates → Prisma INSERT event → PG trigger fires → aggregate updated
    │
    ▼
Response: { event, aggregate }  (or 409/422 on conflict — handled inline)
    │
    ▼
TanStack Query cache updated → UI re-renders
```

**Core invariants — never violate these, in either mode:**
- Events are append-only; state is always derived by replaying the log (or projected via the trigger).
- The PG trigger materializes aggregates on every INSERT — no server-side replay at request time.
- In offline-first: client owns pending events; server owns confirmed state. `useLiveQuery` makes the UI reactive to IndexedDB with zero manual cache wiring.
- In online-only: the server owns everything. The client holds a cache of the server's projection, not a second log.

---

## Step 1 — Gather Domain Events

Ask the user for event names only first, then propose payloads and aggregate effects. Do not ask for everything at once.

**Round 1** — "What are the domain events? List by name (past tense, e.g. `ORDER_PLACED`)."

**Round 2** — Propose minimal payloads. Rule: payload = the minimal immutable facts of the occurrence. Never include derived values (e.g. balance after a deposit).
```
FUND_DEPOSITED  →  amount: number
FUND_WITHDRAWN  →  amount: number
```
Ask the user to confirm or adjust.

**Round 3** — Propose aggregate state shape. Confirm before proceeding.

**Round 4 (offline-first only)** — For each event type, walk through the conflict-policy questionnaire in [references/conflict-handling.md](references/conflict-handling.md#interactive-setup--questions-to-ask-the-user). Do not skip. The answers become `packages/types/src/eventPolicies.ts` and are consumed by both the SyncEngine and the server batch handler.

---

## Step 2 — TypeScript Event Schema

See [references/event-schema.md](references/event-schema.md) for the full pattern.

Generate:
- `BaseEventFields`: `id`, `aggregateId`, `createdAt` (Unix ms), `sequenceNumber`
- One payload interface per event type
- Discriminated union: `type MyEvent = EventA | EventB | ...`
- `StoredEvent = MyEvent & { status: SyncStatus; syncedAt?: number }` (offline-first only; `SyncStatus` includes `'parked'`)
- `computeStateFromEvents()` with exhaustive switch + `never` guard
- Type guards for narrowing: `isDepositedEvent`, etc.
- `eventPolicies` map (offline-first, per event type): `{ occ: 'rebase' | 'reject-and-investigate' | 'append-and-override'; visibility: 'silent' | 'notify' }`

---

## Step 3 — PostgreSQL Schema + Aggregation Trigger

See [references/postgres-aggregation.md](references/postgres-aggregation.md) for complete DDL and trigger code.

Key decisions (both modes):
- Composite unique index `(aggregate_id, sequence_number)` enforces ordering and idempotency
- PL/pgSQL trigger uses `GREATEST(last_seq, NEW.sequence_number)` — safe for out-of-order replays
- `CAPTURE_RELEASED`-style events look up the original event amount via a subquery inside the trigger
- Prisma model maps to the aggregate table; events table uses `@@unique([aggregateId, sequenceNumber])`

Additionally (offline-first):
- `event_investigation` table (see [references/conflict-handling.md](references/conflict-handling.md#investigation-dead-letter-table)) for parked events
- Batch handler must return a typed error envelope: `{ errorClass, errorCode, accepted, rejected, retryAfterMs? }`
- When `eventPolicies[type].occ === 'rebase'` and a `(aggregate_id, sequence_number)` collision is detected, the handler assigns a new server seq and returns it in `rejected[].serverSeq` so the client can reconcile

---

## Step 4 — Client: Dexie + Store + SyncEngine (offline-first only)

> Skip this entire step in online-only mode.

See [references/offline-sync.md](references/offline-sync.md) for full implementation and [references/conflict-handling.md](references/conflict-handling.md) for the conflict taxonomy the SyncEngine must implement.

Key decisions:
- Dexie indexes required: `id, aggregateId, createdAt, sequenceNumber, status, [aggregateId+sequenceNumber]`. Add `retryCount` field for poison-pill detection; add a separate `eventInvestigation` table.
- `status` values: `'pending' | 'synced' | 'failed' | 'parked'`. Only `'synced'` contributes to confirmed state; `'pending'` contributes to optimistic delta; `'failed'` and `'parked'` are excluded from all projections.
- `addEvent()` computes `sequenceNumber` as `max(existing non-parked) + 1` per aggregate, scoped in Dexie.
- `computeAggregateState()` separates confirmed (`synced`) from pending events for two-value display.

### SyncEngine — Sequential Batch Guarantee
This is the load-bearing rule. **The next batch does not start until the current batch resolves.** Do not `Promise.all` aggregate batches. Serialize with `for…of await`.

```
while (pending events exist AND online AND not parked on every aggregate):
  pick next aggregate (FIFO by oldest pending createdAt)
  POST its pending events in sequenceNumber order
  await the response
  route by errorClass (transient | occ | unrecoverable)
  only then move to the next aggregate
```

### Conflict Routing (must-have)
Every failed response routes by `errorClass` — the SyncEngine never branches on HTTP status directly:

- **transient** (network down, 5xx, 408, 429): exponential backoff 1s→2s→4s→8s→16s (cap 30s, honor `retryAfterMs`). Keep `status='pending'`. Stay silent until `SILENT_RETRY_THRESHOLD` (default 3) or `SILENT_RETRY_WINDOW_MS` (default 30s) is exceeded. The app should make a best effort to recover without any user notice.
- **occ** (409, server holds a different event at this seq): apply the per-event-type policy from `eventPolicies`:
  - `rebase` → server returns a new `serverSeq`; client updates the Dexie row to that seq, then renumbers any local pending events on the same aggregate whose seq was `> oldSeq` to close the gap. Cap at `MAX_REBASE_ATTEMPTS = 3`.
  - `reject-and-investigate` → move event to the investigation table, surface per `visibility`.
  - `append-and-override` → server accepts with a new seq; aggregation trigger uses `createdAt` to decide aggregate override.
- **unrecoverable** (400, 401, 403, 422, or OCC budget exhausted): mark `failed`, mirror to server investigation table, block UI only if `visibility === 'notify'`.

### Poison Pill Detection
An event that will never sync must not block the queue forever. Detect when:
- Same event id returns `errorClass: 'unrecoverable'` with the same `errorCode` twice, OR
- Persisted `retryCount >= POISON_RETRY_THRESHOLD` (default 5, across sessions), OR
- Server explicitly sets `poison: true` in the response (preferred)

On detection: set `status='parked'`, copy to the investigation table with a description + category, **renumber subsequent pending events on the same aggregate downward by 1** inside a Dexie transaction, then resume sync. Emit a `poison-pill-detected` app event so an admin view can badge.

Full taxonomy, envelope shape, investigation table schema, and the interactive questionnaire to run with the user are in [references/conflict-handling.md](references/conflict-handling.md).

---

## Step 5 — TanStack Wiring

### TanStack Query — server-confirmed data
```ts
const { data } = useQuery({
  queryKey: ['balance', aggregateId],
  queryFn: () => fetch(`/api/accounts/${aggregateId}/balance`).then(r => r.json()),
});
// Offline-first: invalidate after sync
syncEngine.onSyncComplete((ids) => queryClient.invalidateQueries({ queryKey: ['balance'] }));
```

### TanStack Router
- Write `routeTree.gen.ts` manually (no codegen CLI needed for small apps)
- Pass `queryClient` in router context for loader pre-warming
- Offline-first: `useLiveQuery` handles reactivity; loaders are optional
- Online-only: loaders drive TanStack Query prefetch

### useLiveQuery — primary local data access (offline-first only)
```ts
export function useAggregateEvents(aggregateId: string): StoredEvent[] | undefined {
  return useLiveQuery(async () => {
    const rows = await db.events
      .where('aggregateId').equals(aggregateId)
      .and(e => e.status !== 'parked')
      .sortBy('sequenceNumber');
    return rows.map(dbEventToStoredEvent);
  }, [aggregateId]);
}
// Always returns undefined on first render — guard before rendering
```

---

## Step 6 — Offline Simulation Gate (offline-first only)

`vite.config.ts`: define `VITE_ENABLE_OFFLINE_SIMULATION` from env, default `'false'`.
`.env.development`: set to `'true'`. Never set in `.env.production`.

Guard toggle in UI:
```tsx
{import.meta.env.VITE_ENABLE_OFFLINE_SIMULATION === 'true' && (
  <button onClick={toggleManualOffline}>
    {isManuallyOffline ? 'Go Online' : 'Simulate Offline'}
  </button>
)}
```
`toggleManualOffline` comes from `NetworkStatusContext`. When lifted, SyncEngine immediately flushes its next batch (still one at a time).

---

## Step 7 — Aggregate Snapshots

See [references/snapshots.md](references/snapshots.md) for full implementation.

A **snapshot** is an immutable copy of aggregate state captured before each update to the aggregate table, throttled to at most once per configurable interval (default 60 s). Snapshots are **read-only auxiliary data** — the events table remains authoritative. Applies to both modes; add this feature independently of time-travel whenever cold-start performance is a concern.

### When to add snapshots
- Cold-start load time is too long because the client replays the full event log (offline-first)
- The event log is long enough that full replay is expensive at query time (either mode)
- Auditors need point-in-time state records (prerequisite for time-travel)

### What to implement

**1. Server-side snapshot writes** — extend the PG trigger to write to `balance_snapshots` before updating the aggregate row, guarded by a staleness check against `app_settings.snapshot_interval_seconds`.

**2. Snapshot-based client bootstrap (offline-first)** — replace full IndexedDB replay on cold start with a two-phase fetch:
  - Phase 1: `GET /api/accounts` → seed all current aggregate state
  - Phase 2: `GET /api/accounts/:id/events?afterSeq=<localMax>` → fetch only missing events, upsert as `synced`
  - Call `bootstrapFromSnapshots()` from `SyncEngine.start()` before the first regular sync

---

## Step 8 — Time-Travel

See [references/time-travel.md](references/time-travel.md) for full implementation.

**Prerequisite:** Step 7 (Aggregate Snapshots) must be in place. Time-travel uses `balance_snapshots` as a fast seek point; without them every query replays from genesis.

Time-travel lets users (or auditors) reconstruct the exact aggregate state at any past moment. Works identically in both modes — it queries the server-side log.

### API

`GET /api/accounts/:id/state?at=<unix_ms>`:
  1. Find latest snapshot where `last_event_at ≤ target`
  2. Replay events where `sequence_number > snapshot.last_seq AND created_at ≤ target` (ascending)
  3. Return `{ balance, lastSeq, lastEventAt, snapshotId, eventsReplayed }`

`snapshotId: null` means replayed from genesis — no prior snapshot was found.

### Time-travel UI (`TimeTravelPanel`)
Three input modes (all resolve to `targetMs: number | null`, feed one TanStack Query with `staleTime: Infinity`):
- **Date & Time** — `datetime-local` picker
- **N Events Back** — step N synced events back from latest; `syncedEvents[length - n].createdAt`
- **Duration Back** — `HH:mm:ss` string; `Date.now() - parsedMs`

After a result loads, a `cursorIndex` anchors to `syncedEvents[findIndex(seq === data.lastSeq)]`. ← / → buttons navigate one event at a time, triggering new queries via updated `targetMs`. Below the result: a scrollable list of the last N events up to the cursor, N configurable (5/10/25/50, default 10).

Key rule: only `status === 'synced'` events participate in navigation — pending and parked events are not yet canonical.

---

## Online-only Mode — Conflict Handling Without a Client Log

Online-only drops Dexie, the SyncEngine, and the pending/synced split — but OCC is still real. Two users racing on the same aggregate will still collide at the `(aggregate_id, sequence_number)` unique index.

### Command endpoint shape
```
POST /api/commands/:aggregateType
Body: { aggregateId, type, payload, expectedSequenceNumber? }
Resp: { event, aggregate } | 409 { errorClass, errorCode, currentSequenceNumber, winningEvent }
```

The client sends the **command** (intent) and optionally an `expectedSequenceNumber` it last observed. The server assigns the actual sequence number — there is no client-side seq counter.

### Conflict routing (same taxonomy, inline)
- **transient** (5xx, 408, 429, fetch error): TanStack Query retries per its default policy. No user notice for the first `N` attempts.
- **occ** (409 because `expectedSequenceNumber` was stale): decide per event type by the same `eventPolicies` map used offline-first. `rebase` means the server just accepted the command with a new seq and returns the event normally (no 409). `reject-and-investigate` means the 409 body carries the winning event payload and the UI must re-fetch, re-show, and ask the user to reconfirm.
- **unrecoverable** (400, 401, 403, 422): surface a validation error inline; write to `event_investigation` server-side; no retry.

### Why the same `eventPolicies` map?
Because the business rules ("is a later deposit still valid if it races?") are identical whether the conflict was detected after a week offline or after 50 ms of network latency. Keep one source of truth, read it from the server batch handler in offline-first and from the command handler in online-only.

### What online-only does NOT need
- No SyncEngine, no sequential batch loop — each command is its own request.
- No poison-pill concept for sync — a command either succeeds, is rejected with a validation error the user can correct, or stalls on network (TanStack Query retries).
- No investigation table on the client — the server's `event_investigation` is still worth having for auditability of rejected commands.

---

## Optimistic vs Confirmed Balance (offline-first)

| Field | Meaning |
|---|---|
| `confirmedBalance` | Replay of `synced` events only |
| `pendingDelta` | Net effect of `pending` events |
| `balance` (display) | `confirmedBalance + pendingDelta` |
| `pendingBalance` | `pendingDelta` shown separately in amber |

Parked events contribute to neither and are only visible in the admin investigation view.

---

## API Contract Summary

| Method | Path | Purpose | Mode |
|---|---|---|---|
| `POST` | `/api/events/batch` | Submit pending events; returns `{ errorClass, accepted[], rejected[], serverBalance }` | offline-first |
| `POST` | `/api/commands/:aggregateType` | Single command, server appends event | online-only |
| `GET` | `/api/accounts/:id/balance` | Current confirmed balance | both |
| `GET` | `/api/accounts/:id/events` | Last 10 events (desc); or `?afterSeq=n` for catch-up (asc) | both |
| `GET` | `/api/accounts` | All aggregate snapshots — bootstrap only | offline-first |
| `GET` | `/api/accounts/:id/state?at=T` | Time-travel: state at Unix ms T | both |
| `POST` | `/api/events/dead-letter` | Mirror a parked event to server | offline-first |
| `GET` | `/api/events/dead-letter` | Admin feed of parked events | both |
| `POST` | `/api/events/dead-letter/:id/resolve` | Admin action: discard / reissue / force-accept | both |

**409 on batch** (offline-first) = classify via `errorClass` and route: `occ` → rebase or investigate per policy; `unrecoverable` → mark failed + mirror to investigation. Never blindly mark "all events for that aggregate as failed" — that loses work and can create phantom poison pills.
