# Building Truly Offline-First Apps with Event Sourcing, TanStack, and PostgreSQL

*How two independent event logs — one in the browser, one in the database — turn flaky connectivity from a crisis into a non-event, and give you time travel for free.*

---

## Two Event Logs, Loosely Coupled

Most "offline-first" apps are optimistic-UI apps wearing a disguise. They cache the last server response, let you poke around, and then nervously reconcile when the network returns. The moment two devices diverge, or a sync fails mid-way, you're left with a state machine that nobody designed and nobody trusts.

The architecture in this post takes a different approach: **event sourcing runs at both layers**, independently.

```text
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CLIENT (Browser)                                     │
│                                                                 │
│   User action                                                   │
│       │                                                         │
│       ▼                                                         │
│   addEvent()  ──▶  IndexedDB (Dexie)  ──▶  useLiveQuery        │
│                     append-only log         reactive UI         │
│                                                                 │
│   State = computeStateFromEvents(localLog)                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
              sync pending events (pure JSON)
              when network is available
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  LAYER 2 — SERVER (PostgreSQL)                                  │
│                                                                 │
│   POST /api/events/batch                                        │
│       │                                                         │
│       ▼                                                         │
│   events table  ──▶  PG trigger fires  ──▶  account_balances   │
│   append-only log     on every INSERT        materialized view  │
│                                                                 │
│   State = materialized aggregate (O(1) lookup)                  │
└─────────────────────────────────────────────────────────────────┘
```

Each layer is a **complete, self-consistent event-sourced system**. The client log drives the UI. The server log drives the authoritative state. The only thing crossing the boundary is plain event objects — no state deltas, no merge instructions, no version vectors.

### Why two layers instead of one?

A single event log with the server as the authority is the classic event sourcing setup. It works well when you're always online. Add network unreliability and it breaks in a familiar way: the UI freezes or lies while waiting for the server.

The two-layer model sidesteps this entirely:

| | Single log (server-authoritative) | Two-layer (this architecture) |
| --- | --- | --- |
| Works offline | No — writes block on network | Yes — client log is independent |
| Conflict detection | Must coordinate in real time | Sequence numbers; visible on sync |
| UI latency | Round-trip per action | Zero — IndexedDB write is synchronous |
| Audit trail | Server only | Both client and server |

### The coupling point: pure events

The bridge between the two layers is intentionally minimal. The sync engine sends batches of raw event objects:

```typescript
// What crosses the wire — nothing more
POST /api/events/batch
[
  { id: "uuid-1", type: "DEPOSITED", payload: { amount: 100 },
    accountId: "acc-1", sequenceNumber: 7, createdAt: 1710000000000 }
]
```

No state. No computed values. No "here's what the balance should be." The server recomputes everything from the events it receives, just as the client does from the events it holds. This is what makes the coupling loose: neither side depends on what the other has *derived* — only on the raw facts of what *happened*.

### Network failures are a non-event

Because the client log is append-only and fully local, network outages don't interrupt the user at all:

```text
  Online:   write ──▶ IndexedDB ──▶ sync immediately ──▶ server ACKs ──▶ status: synced
                                         ↕ (network fine)

  Offline:  write ──▶ IndexedDB ──▶ queued                             ──▶ status: pending
                                         ↕ (network gone)
                                         ↕
            reconnect              ──▶ drain queue ──▶ server ACKs ──▶ status: synced
```

The amber "pending" indicator in the UI reflects exactly this: the event exists, the state is correct, the server just hasn't confirmed it yet. When the network returns, the sync engine drains the queue in order and the pending badges disappear. Nothing was lost. Nothing needs to be re-entered.

---

## The Problem with Syncing State

Imagine a funds management app. A user deposits $100 while offline, then their colleague approves a withdrawal on the server. When the offline user reconnects, whose version wins?

If you're syncing a `balance` field, you're stuck choosing: last-write-wins (wrong), server-wins (annoying), or a custom merge function (complex and fragile).

The root cause: you've thrown away the *reason* the balance changed. The event — "deposit $100" — is richer than the resulting number.

**Event sourcing flips the model.** You never sync current state. You sync the sequence of events that *produce* that state. The balance is always derived by replaying the log. Conflicts become visible ("two events claim sequence number 7") and the resolution strategy is explicit.

---

## Events as the Single Source of Truth

In this architecture, every user action creates an immutable event appended to a log:

```typescript
type FundsEvent =
  | { type: 'ACCOUNT_CREATED'; payload: { ownerName: string } }
  | { type: 'DEPOSITED';       payload: { amount: number } }
  | { type: 'WITHDRAWN';       payload: { amount: number } }
  | { type: 'CAPTURED';        payload: { amount: number; referenceId: string } }
  | { type: 'CAPTURE_RELEASED'; payload: { referenceId: string } };
```

This TypeScript discriminated union is the domain model. The `type` field is the discriminator; TypeScript enforces exhaustive handling:

```typescript
function computeStateFromEvents(events: FundsEvent[]): AccountState {
  let balance = 0;
  const captures = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case 'ACCOUNT_CREATED':
        ownerName = event.payload.ownerName;
        break;
      case 'DEPOSITED':
        balance += event.payload.amount;
        break;
      case 'WITHDRAWN':
        balance -= event.payload.amount;
        break;
      case 'CAPTURED':
        captures.set(event.payload.referenceId, event.payload.amount);
        balance -= event.payload.amount;
        break;
      case 'CAPTURE_RELEASED': {
        const capturedAmount = captures.get(event.payload.referenceId) ?? 0;
        balance += capturedAmount;
        captures.delete(event.payload.referenceId);
        break;
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  return { balance };
}
```

The `never` check means adding a new event type without updating this function is a **compile error**. This is one of the concrete payoffs of the discriminated union pattern.

Crucially, this function lives in `packages/types` — shared between client and server. Both derive the same state from the same events. There's no risk of the client and server computing different balances from identical inputs.

---

## TanStack: Two Different Jobs, Two Different Tools

This is where many people reach for a single state management solution and then fight it. TanStack separates concerns clearly:

**TanStack Query** manages *server state* — data that lives on the server and needs to be fetched, cached, and invalidated. It's used here for the server-authoritative balance view and the time-travel historical state endpoint.

**Dexie + `useLiveQuery`** manages *local state* — the client's own event log stored in IndexedDB. This is the real-time source of truth for everything the user interacts with.

The split is intentional and powerful:

```text
User interaction
      ↓
addEvent() → IndexedDB (Dexie)
      ↓
useLiveQuery fires → component re-renders
      ↓ (background)
SyncEngine POSTs to server
      ↓
Server confirms → syncEngine.onSyncComplete()
      ↓
queryClient.invalidateQueries(['serverBalance']) → TanStack Query refetches
```

`useLiveQuery` is Dexie's reactive hook. It subscribes to IndexedDB changes and re-runs its async function automatically, returning `undefined` during the first load and the computed result afterward:

```typescript
export function useAccountState(accountId: string) {
  return useLiveQuery(async () => {
    const dbEvents = await db.events
      .where('accountId').equals(accountId)
      .sortBy('sequenceNumber');

    return computeAccountState(dbEvents.map(dbEventToStoredEvent));
  }, [accountId]);
}
```

Every time an event is written to IndexedDB — whether by the user or by the sync engine marking an event as confirmed — this hook re-runs and the component updates. No polling. No manual cache invalidation. No `useEffect` chains.

---

## Offline-First: Pending vs. Confirmed

The local event log tracks a `status` field: `'pending'`, `'synced'`, or `'failed'`. This is the key to optimistic UI without lying to the user:

```typescript
export function computeAccountState(events: StoredEvent[]): AccountState {
  let confirmedBalance = 0;
  let pendingDelta = 0;

  for (const event of events) {
    const delta = balanceDeltaFor(event);
    if (event.status === 'synced') {
      confirmedBalance += delta;
    } else {
      pendingDelta += delta;
    }
  }

  return {
    balance: confirmedBalance + pendingDelta, // shown to user
    pendingBalance: pendingDelta,             // shown as amber badge
  };
}
```

The user sees their deposit instantly. The amber "pending" badge tells them it hasn't reached the server yet. When sync completes, the badge disappears and the confirmed balance catches up. No loading spinner. No "operation may take a few seconds."

When the user goes offline — or clicks "Simulate Offline" in the dev UI — events queue up in IndexedDB. The app functions completely. When connectivity returns, the sync engine drains the queue in order.

---

## The Sync Engine: Reliability, Not Just Optimism

Optimistic UI is easy. Making it *reliable* is where most implementations fall short. The sync engine here is a small but carefully designed state machine:

```text
pending → (POST /api/events/batch) → synced
                                  → failed (409 conflict or max retries)
```

**Batching by account.** Events are grouped by `accountId` and sent in sequence-number order. This ensures the server always sees a contiguous log, not a scrambled one.

**Idempotency.** Each event carries a UUID generated at creation time. If the same event is submitted twice (e.g., the client crashed after sending but before receiving the ACK), the server detects it by ID and returns `accepted` again. No duplicate transactions.

**Sequence conflict handling.** The PostgreSQL schema enforces `UNIQUE(account_id, sequence_number)`. If two clients both created event #7 for the same account, the second POST receives a 409. The engine marks those events `failed` and stops retrying — an operator needs to investigate. This is the right answer: fail loudly, never silently corrupt.

**Exponential backoff.** Transient failures (network blip, server restart) are retried with 1s → 2s → 4s delays. After `MAX_RETRIES`, events are marked failed. The UI can surface this to the user.

```typescript
private scheduleRetry(): void {
  this.retryCount = Math.min(this.retryCount + 1, MAX_RETRIES);
  const delay = BASE_DELAY_MS * Math.pow(2, this.retryCount - 1);
  this.syncTimeout = setTimeout(() => void this.sync(), delay);
}
```

---

## PostgreSQL as an Event Pipeline

On the server, events are inserted into a single `events` table. But the application never queries that table directly for the current balance. Instead, a PL/pgSQL trigger fires after every `INSERT` and materializes the aggregate into `account_balances`:

```sql
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO account_balances (account_id, balance, last_seq, last_event_at)
  VALUES (NEW.account_id, 0, NEW.sequence_number, NEW.created_at)
  ON CONFLICT (account_id) DO UPDATE
    SET balance      = account_balances.balance + (
                         CASE NEW.type
                           WHEN 'DEPOSITED'  THEN (NEW.payload->>'amount')::numeric
                           WHEN 'WITHDRAWN'  THEN -((NEW.payload->>'amount')::numeric)
                           WHEN 'CAPTURED'   THEN -((NEW.payload->>'amount')::numeric)
                           ELSE 0
                         END),
        last_seq     = GREATEST(account_balances.last_seq, NEW.sequence_number),
        last_event_at = GREATEST(account_balances.last_event_at, NEW.created_at),
        updated_at   = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

This is **eventual consistency as a database primitive**. The moment an event is committed, the materialized view is updated — atomically, in the same transaction. No background worker. No eventual-consistency lag. The `account_balances` table is always in sync with the event log.

The API then reads from this materialized view for O(1) balance lookups, regardless of how many events an account has accumulated.

---

## Snapshots: Making Cold Start Fast

Replaying the full event log on every app open is fine for 50 events. For 50,000 it's not. The solution is **snapshots**: periodic checkpoints of the aggregate state.

A `balance_snapshots` table holds point-in-time captures:

```sql
CREATE TABLE balance_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  balance      NUMERIC NOT NULL,
  last_seq     INTEGER NOT NULL,
  last_event_at BIGINT NOT NULL,
  captured_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON balance_snapshots (account_id, last_event_at DESC);
```

On cold start, the client runs a two-phase bootstrap:

1. **Fetch** `GET /api/accounts` — returns all accounts' current materialized balance plus `lastSeq`.
2. **For each account**, fetch only events after the local max sequence number: `GET /api/accounts/{id}/events?afterSeq={n}`.
3. **Upsert** those events into IndexedDB as `synced`. The local state is now current.

```typescript
// Phase 1: what does the server know?
const snapshots = await fetch('/api/accounts').then(r => r.json());

// Phase 2: fill in only the gap
for (const { accountId, lastSeq } of snapshots) {
  const localMaxSeq = await getLocalMaxSeq(accountId);
  const missing = await fetch(
    `/api/accounts/${accountId}/events?afterSeq=${Math.min(localMaxSeq, lastSeq)}`
  ).then(r => r.json());

  await db.events.bulkPut(missing.events.map(e => ({ ...e, status: 'synced' })));
}
```

The result: a returning user starts up in milliseconds, not seconds. Only the delta is transferred. This is the same pattern CDNs use for cache invalidation — instead of "give me everything," it's "give me what I don't have."

---

## Time Travel: The Hidden Superpower of Event Sourcing

Event logs are immutable and ordered. That means you can reconstruct *any past state* by replaying up to any point in time. This isn't just a theoretical benefit — it's directly useful:

**Analytics:** "What was the average balance across all accounts at end of last quarter?" Query the event log, don't touch the materialized view.

**Backoffice inspection:** "The customer claims their balance was $2,400 last Tuesday. Show me." Reconstruct it on demand.

**Debugging:** "The API returned an error at 14:32:07. What did the account look like at that exact moment?" Replay to that timestamp.

**Regulatory audit:** Every transaction is immutable and timestamped. There's no "correcting" a record — you create a compensating event. The trail is complete.

### The Algorithm

The server's `GET /api/accounts/:id/state?at=<unix_ms>` endpoint uses a two-step algorithm:

```typescript
// Step 1: Find the closest snapshot at or before the target time
const snapshot = await prisma.balanceSnapshot.findFirst({
  where: { accountId, lastEventAt: { lte: targetMs } },
  orderBy: { lastEventAt: 'desc' },
});

// Step 2: Replay only events after the snapshot up to the target time
const events = await prisma.event.findMany({
  where: {
    accountId,
    sequenceNumber: { gt: snapshot?.lastSeq ?? 0 },
    createdAt: { lte: targetMs },
  },
  orderBy: { sequenceNumber: 'asc' },
});

// Seed from snapshot, then replay delta
let balance = Number(snapshot?.balance ?? 0);
for (const event of events) {
  balance = applyEvent(balance, event);
}
```

The snapshot index `(accountId, lastEventAt DESC)` makes the seek O(log n). The replay is then a linear scan of only the events between the snapshot and the target — usually a small number if snapshots are taken regularly.

### The UI

The client's `TimeTravelPanel` exposes three navigation modes, all resolving to a single `targetMs`:

- **Date & Time** — pick any datetime with a calendar input
- **N Events Back** — "show me what it looked like 5 events ago"
- **Duration Back** — "show me what it looked like 2 hours ago" (format: `HH:mm:ss`)

```typescript
const targetMs = useMemo(() => {
  switch (mode) {
    case 'datetime':
      return new Date(selectedDatetime).getTime();
    case 'events-back': {
      const idx = Math.max(0, syncedEvents.length - parseInt(eventsBack));
      return syncedEvents[idx]?.createdAt ?? null;
    }
    case 'duration-back':
      return Date.now() - parseDurationMs(durationStr);
  }
}, [mode, selectedDatetime, eventsBack, durationStr, syncedEvents]);
```

TanStack Query fetches the historical state with `staleTime: Infinity` — a given timestamp always produces the same result, so there's no point ever re-fetching:

```typescript
const { data } = useQuery({
  queryKey: ['time-travel', accountId, targetMs],
  queryFn: () => fetch(`/api/accounts/${accountId}/state?at=${targetMs}`).then(r => r.json()),
  enabled: targetMs !== null,
  staleTime: Infinity,
});
```

Once a result loads, prev/next navigation buttons let you step through the event timeline one event at a time — each step triggers a new query (or a cache hit if you've been there before). The UI shows the historical balance alongside the current balance, the sequence number, and how many events were replayed from the nearest snapshot.

---

## The Full Data Flow

Here's the complete journey from user action to server-consistent view:

```text
User taps "Deposit $100"
        ↓
addEvent() writes { status: 'pending' } to IndexedDB
        ↓
useLiveQuery fires → balance shows $600 (amber: +$100 pending)
        ↓  (background, immediately)
SyncEngine.triggerSync()
        ↓
POST /api/events/batch → { accepted: ['uuid-1'], rejected: [] }
        ↓
markEventSynced('uuid-1') → IndexedDB update
        ↓
useLiveQuery fires → balance shows $600 (green: confirmed)
        ↓
SyncEngine calls onSyncComplete(['account-xyz'])
        ↓
queryClient.invalidateQueries(['serverBalance', 'account-xyz'])
        ↓
TanStack Query refetches → server confirms $600
        ↓  (on the server, after INSERT)
PG trigger fires → account_balances.balance = $600
```

The client UI is responsive in the first step. The server is consistent by the last step. In between, the amber pending indicator bridges the gap honestly.

---

## Why This Matters Beyond Funds Management

The architecture described here is domain-agnostic. The event sourcing + sync + snapshot pattern applies to:

- **Collaborative editors** — ops are events; CRDTs are the state function
- **IoT sensor data** — readings are events; aggregates are time-series summaries
- **E-commerce carts** — add/remove/checkout are events; cart state is derived
- **Task managers** — create/assign/complete are events; todo list is the view

What you get for free, regardless of domain:

1. **True offline support** — the local log is complete, not a cache
2. **Conflict visibility** — sequence violations surface immediately, not silently
3. **Audit trail** — every change is a first-class record, not an overwrite
4. **Time travel** — historical state at any point is computable, not reconstructed from backups
5. **Optimistic UI without lies** — pending/confirmed distinction is explicit, not hidden

---

## Conclusion

The key insight is that offline-first and audit trails are the *same thing* approached from different directions. An immutable event log gives you both. Once you stop thinking about syncing *state* and start thinking about syncing *what happened*, a lot of hard problems dissolve.

TanStack Router and Query don't replace this architecture — they amplify it. `useLiveQuery` from Dexie handles the reactive local layer. TanStack Query handles the server-authoritative layer. Each does exactly one job and does it well. The sync engine is the small, explicit bridge between them.

And PostgreSQL, rather than being a passive store, becomes an active participant: triggers materialize views the moment events arrive, snapshots accelerate cold start, and a simple `WHERE createdAt <= ?` turns any query into a time machine.

The result is a system that fails gracefully, scales cleanly, and gives operators the inspection tools they need — without any of these capabilities being bolted on after the fact. They emerge from the foundation.

---

*The full source code for this architecture, including the sync engine, PostgreSQL trigger, and time travel UI, is available in the accompanying repository.*

---

## Claude Code Skill: Build This Architecture with AI Assistance

If you use [Claude Code](https://claude.ai/claude-code), the entire architecture described in this post is packaged as an installable skill — a self-contained expert guide that Claude loads on demand whenever you're working on event-sourced apps. It covers all eight implementation steps (domain events → TypeScript schema → PostgreSQL trigger → Dexie client → TanStack wiring → offline simulation → snapshots → time travel), including the full reference code for each layer.

### Install the skill

#### Option 1 — Plugin marketplace (recommended)

In any Claude Code session:

```text
/plugin marketplace add bnaya-eshet/TanStackEventSourcing
/plugin install tanstack-event-sourcing@tanstack-event-sourcing-marketplace
```

#### Option 2 — npm

```bash
npm install -g tanstack-event-sourcing-skill
```

Then add the installed skill directory to your `.claude/skills/` folder, or configure it in your project's `settings.json`.

#### Option 3 — Direct download

Download the latest `tanstack-event-sourcing.skill` file from the [GitHub Releases page](https://github.com/bnaya-eshet/TanStackEventSourcing/releases) and install it via the Claude Code UI.

### What the skill does

Once installed, Claude automatically suggests the skill when it detects event-sourcing patterns in your prompts or files. You can also invoke it explicitly:

> *"Help me add a CAPTURED event to my funds domain"*
> *"Set up a Dexie SyncEngine with exponential backoff"*
> *"Design the PostgreSQL aggregation trigger for my orders table"*
> *"Add snapshot-based cold-start bootstrap"*
> *"Build a time-travel UI for my event log"*

Claude will follow the exact patterns from this post — discriminated union types, the PG trigger idiom, the two-phase bootstrap, the `staleTime: Infinity` TanStack Query pattern — rather than improvising from scratch.
