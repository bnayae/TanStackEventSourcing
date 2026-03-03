---
name: tanstack-event-sourcing
description: "Expert guide for building full-stack event-sourced applications using TanStack Router, TanStack Query, Dexie (IndexedDB), Express, Prisma, and PostgreSQL. Use this skill when: building an event-sourced app from scratch; adding domain events or discriminated union types; designing a PostgreSQL aggregation trigger or materialized view; implementing offline-first optimistic UI with IndexedDB; wiring useLiveQuery with Dexie; setting up SyncEngine for background sync with exponential backoff; handling pending vs confirmed (optimistic) state; adding server-side aggregate snapshots; implementing snapshot-based cold-start bootstrap; accelerating cold start with snapshot bootstrap; reducing event replay cost; balance snapshot; bootstrapFromSnapshots; afterSeq; building time-travel queries to reconstruct past aggregate state; creating a time-travel UI with event navigation; time-travel; time travel; point-in-time; historical state; explaining how events flow from client write to server confirmation; debugging sequence conflicts or 409 errors; setting up the offline simulation toggle."
---

# TanStack Event Sourcing — Expert Guide

## Event Flow (core mental model)

```
[User action]
    │
    ▼
addEvent() → Dexie IndexedDB (status=pending)
    │                  │
    │                  ▼
    │      useLiveQuery → React re-render (optimistic UI immediately)
    │
    ▼ (background, SyncEngine)
POST /api/events/batch
    │
    ▼
Prisma INSERT → PG trigger fires → aggregate table updated
    │
    ▼
markEventSynced() → Dexie status=synced → confirmed UI
```

**Core invariants — never violate these:**
- Events are append-only; state is always derived by replaying the log
- Client owns pending events; server owns confirmed state
- The PG trigger materializes aggregates on every INSERT — no server-side replay at request time
- `useLiveQuery` (dexie-react-hooks) makes the UI reactive to IndexedDB with zero manual cache wiring

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

---

## Step 2 — TypeScript Event Schema

See [references/event-schema.md](references/event-schema.md) for the full pattern.

Generate:
- `BaseEventFields`: `id`, `aggregateId`, `createdAt` (Unix ms), `sequenceNumber`
- One payload interface per event type
- Discriminated union: `type MyEvent = EventA | EventB | ...`
- `StoredEvent = MyEvent & { status: SyncStatus; syncedAt?: number }`
- `computeStateFromEvents()` with exhaustive switch + `never` guard
- Type guards for narrowing: `isDepositedEvent`, etc.

---

## Step 3 — PostgreSQL Schema + Aggregation Trigger

See [references/postgres-aggregation.md](references/postgres-aggregation.md) for complete DDL and trigger code.

Key decisions:
- Composite unique index `(account_id, sequence_number)` enforces ordering and idempotency
- PL/pgSQL trigger uses `GREATEST(last_seq, NEW.sequence_number)` — safe for out-of-order replays
- `CAPTURE_RELEASED` looks up the original `CAPTURED` event amount via a subquery inside the trigger
- Prisma model maps to the aggregate table; events table uses `@@unique([accountId, sequenceNumber])`

---

## Step 4 — Client: Dexie + Store + SyncEngine

See [references/offline-sync.md](references/offline-sync.md) for full implementation.

Key decisions:
- Dexie indexes required: `id, accountId, createdAt, sequenceNumber, status, [accountId+sequenceNumber]`
- `addEvent()` computes `sequenceNumber` as `max(existing) + 1` per account, scoped in Dexie
- `computeAccountState()` separates confirmed (`synced`) from pending events for two-value display
- `SyncEngine` groups pending events by accountId, POSTs batches, handles 409 sequence conflicts, exponential backoff (MAX_RETRIES=3, BASE_DELAY=1000ms)
- On 409: mark all events for that account as `failed`; do not retry automatically

---

## Step 5 — TanStack Wiring

### TanStack Query — server-confirmed data
```ts
const { data } = useQuery({
  queryKey: ['balance', aggregateId],
  queryFn: () => fetch(`/api/accounts/${aggregateId}/balance`).then(r => r.json()),
});
// Invalidate after sync:
syncEngine.onSyncComplete((ids) => queryClient.invalidateQueries({ queryKey: ['balance'] }));
```

### TanStack Router
- Write `routeTree.gen.ts` manually (no codegen CLI needed for small apps)
- Pass `queryClient` in router context for loader pre-warming
- `useLiveQuery` handles reactivity; loaders are optional

### useLiveQuery — primary local data access
```ts
export function useAggregateEvents(aggregateId: string): StoredEvent[] | undefined {
  return useLiveQuery(async () => {
    const rows = await db.events
      .where('aggregateId').equals(aggregateId)
      .sortBy('sequenceNumber');
    return rows.map(dbEventToStoredEvent);
  }, [aggregateId]);
}
// Always returns undefined on first render — guard before rendering
```

---

## Step 6 — Offline Simulation Gate

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
`toggleManualOffline` comes from `NetworkStatusContext`. When lifted, SyncEngine immediately flushes.

---

## Step 7 — Aggregate Snapshots

See [references/snapshots.md](references/snapshots.md) for full implementation.

A **snapshot** is an immutable copy of aggregate state captured before each update to the aggregate table, throttled to at most once per configurable interval (default 60 s). Snapshots are **read-only auxiliary data** — the events table remains authoritative. Add this feature independently of time-travel whenever cold-start performance is a concern.

### When to add snapshots
- Cold-start load time is too long because the client replays the full event log
- The event log is long enough that full replay is expensive at query time
- Auditors need point-in-time state records (prerequisite for time-travel)

### What to implement

**1. Server-side snapshot writes** — extend the PG trigger to write to `balance_snapshots` before updating the aggregate row, guarded by a staleness check against `app_settings.snapshot_interval_seconds`.

**2. Snapshot-based client bootstrap** — replace full IndexedDB replay on cold start with a two-phase fetch:
  - Phase 1: `GET /api/accounts` → seed all current aggregate state
  - Phase 2: `GET /api/accounts/:id/events?afterSeq=<localMax>` → fetch only missing events, upsert as `synced`
  - Call `bootstrapFromSnapshots()` from `SyncEngine.start()` before the first regular sync

---

## Step 8 — Time-Travel

See [references/time-travel.md](references/time-travel.md) for full implementation.

**Prerequisite:** Step 7 (Aggregate Snapshots) must be in place. Time-travel uses `balance_snapshots` as a fast seek point; without them every query replays from genesis.

Time-travel lets users (or auditors) reconstruct the exact aggregate state at any past moment.

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

Key rule: only `status === 'synced'` events participate in navigation — pending events are not yet on the server.

---

## Optimistic vs Confirmed Balance

| Field | Meaning |
|---|---|
| `confirmedBalance` | Replay of `synced` events only |
| `pendingDelta` | Net effect of `pending` events |
| `balance` (display) | `confirmedBalance + pendingDelta` |
| `pendingBalance` | `pendingDelta` shown separately in amber |

---

## API Contract Summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/events/batch` | Submit pending events; returns `accepted[]`, `rejected[]`, `serverBalance` |
| `GET` | `/api/accounts/:id/balance` | Current confirmed balance |
| `GET` | `/api/accounts/:id/events` | Last 10 events (desc); or `?afterSeq=n` for catch-up (asc) |
| `GET` | `/api/accounts` | All aggregate snapshots — bootstrap only |
| `GET` | `/api/accounts/:id/state?at=T` | Time-travel: state at Unix ms T |

409 on batch = sequence conflict → mark all events for that account as `failed`.
