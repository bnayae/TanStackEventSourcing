---
name: tanstack-event-sourcing
description: >
  Full-stack event sourcing pattern: TanStack Router + TanStack Query + Dexie (IndexedDB)
  on the frontend for offline-first optimistic UI; Express + Prisma + PostgreSQL with a
  materialized-view trigger on the backend. Use this skill when:
  - Building a new event-sourced application with this stack from scratch
  - Adding new domain event types and their TypeScript discriminated union
  - Setting up the PostgreSQL schema, Prisma models, and aggregation trigger
  - Implementing the offline-first client (Dexie + SyncEngine)
  - Wiring TanStack Router routes and useLiveQuery hooks over local IndexedDB
  - Enabling the env-gated offline simulation toggle (non-prod only)
  - Explaining how optimistic vs confirmed balance works
  - Any question about how events flow from client write to server confirmation
---

# TanStack Event Sourcing

## Pattern Overview

```
[User action]
    │
    ▼
addEvent() → Dexie IndexedDB (status=pending)
    │                  │
    │                  ▼
    │      useLiveQuery → React re-render
    │      computeState → optimistic UI shown immediately
    │
    ▼ (background)
SyncEngine: POST /api/events/batch
    │
    ▼
Server: Prisma INSERT → PG trigger fires → account_balances updated
    │
    ▼
SyncEngine: markEventSynced → Dexie status=synced
    │
    ▼
useLiveQuery → confirmed balance visible
```

Core invariants:

- Events are **append-only**; state is always derived by replaying the log
- The client is the source of truth for **pending** events; server for **confirmed** state
- The PG trigger materializes aggregates on every `INSERT` — no server-side replay
- `useLiveQuery` (dexie-react-hooks) makes UI reactive to IndexedDB without manual cache invalidation

---

## Step 1 — Define Domain Events

Before writing any code, collect event definitions from the user. Ask for the event names only first, then propose payloads and aggregate effects based on the names — don't ask for everything at once.

**Round 1 — Event names**
Ask: "What are the domain events for your system? List them by name (past tense, e.g. `ORDER_PLACED`)."

**Round 2 — Propose payloads**
For each event name, propose a minimal payload using a simple DSL (`field: type`). Derive fields from the event semantics — e.g. for `FUND_DEPOSITED` propose `amount: number, currency: string`. Apply the rule: payload = the minimal immutable facts needed to represent this occurrence. Never include derived values (e.g. the resulting balance after a deposit).

Example proposal format:
```
FUND_DEPOSITED  →  amount: number, currency: string
FUND_WITHDRAWN  →  amount: number, currency: string
```
Ask the user to confirm or adjust each payload.

**Round 3 — Propose aggregates**
Ask for the aggregate name(s), then propose the aggregate state shape derived from the events and their effects. Example:

> Aggregate `AccountBalance`:
> - `balance: number` — increased by `amount` on `FUND_DEPOSITED`, decreased on `FUND_WITHDRAWN`

Ask: "Does this aggregate look right? Would you like to define another aggregate over the same events before we continue?"
Repeat until the user confirms all aggregates are defined.

Once events and aggregates are confirmed, move to Step 2.

---

## Step 2 — TypeScript Event Schema

See [references/event-schema.md](references/event-schema.md) for the complete pattern.

Summary of what to generate:

- `BaseEventFields`: `id`, `aggregateId`, `createdAt` (Unix ms), `sequenceNumber`
- One payload interface per event type
- Discriminated union: `type MyEvent = EventA | EventB | ...`
- `StoredEvent = MyEvent & { status: SyncStatus; syncedAt?: number }`
- `computeStateFromEvents()` with exhaustive switch + `never` guard
- Type guards for narrowing in handlers

---

## Step 3 — PostgreSQL Schema + Aggregation Trigger

See [references/postgres-aggregation.md](references/postgres-aggregation.md) for:

- Prisma schema (`Event` model + materialized aggregate model)
- Full migration SQL: table DDL, composite unique index `(aggregate_id, sequence_number)`, PL/pgSQL trigger
- Template for extending the trigger with new event types

---

## Step 4 — Client: Dexie + Store + SyncEngine

See [references/offline-sync.md](references/offline-sync.md) for:

- Dexie schema with required indexes
- `addEvent()` — auto-increments `sequenceNumber` per aggregate
- `computeAccountState()` — splits confirmed vs pending balance
- `SyncEngine` — groups pending events by aggregate, POSTs batches, handles 409 conflicts and exponential backoff
- `NetworkStatusContext` — browser online/offline events + manual toggle
- Offline simulation env gate

---

## Step 5 — TanStack Wiring

### TanStack Query (server-confirmed data only)

```ts
const { data } = useQuery({
  queryKey: ["balance", aggregateId],
  queryFn: () =>
    fetch(`/api/accounts/${aggregateId}/balance`).then((r) => r.json()),
});
// Invalidate after sync: syncEngine.onSyncComplete(() => queryClient.invalidateQueries(...))
```

### TanStack Router

- Write `routeTree.gen.ts` manually for small apps (no codegen CLI needed)
- Pass `queryClient` in router context for loader pre-warming
- Loaders are optional — `useLiveQuery` handles reactivity without them

### useLiveQuery (primary data access pattern)

```ts
export function useAggregateEvents(
  aggregateId: string,
): StoredEvent[] | undefined {
  return useLiveQuery(async () => {
    const rows = await db.events
      .where("aggregateId")
      .equals(aggregateId)
      .sortBy("sequenceNumber");
    return rows.map(dbEventToStoredEvent);
  }, [aggregateId]);
}
// undefined while loading — always guard before rendering
```

---

## Step 6 — Offline Simulation Gate

Add to `vite.config.ts`:

```ts
define: {
  'import.meta.env.VITE_ENABLE_OFFLINE_SIMULATION':
    JSON.stringify(process.env.VITE_ENABLE_OFFLINE_SIMULATION ?? 'false'),
}
```

`.env.development`:

```
VITE_ENABLE_OFFLINE_SIMULATION=true
```

Never set in `.env.production`.

In the UI, guard the toggle button:

```tsx
{
  import.meta.env.VITE_ENABLE_OFFLINE_SIMULATION === "true" && (
    <button onClick={toggleManualOffline}>
      {isManuallyOffline ? "Go Online" : "Simulate Offline"}
    </button>
  );
}
```

`toggleManualOffline` comes from `NetworkStatusContext` (see offline-sync reference).
When toggled off, SyncEngine immediately attempts a sync flush.

---

## Optimistic vs Confirmed Balance

`computeAccountState(events: StoredEvent[])` separates by `event.status`:

| Field               | Meaning                                     |
| ------------------- | ------------------------------------------- |
| `confirmedBalance`  | Replay of `status === 'synced'` events only |
| `pendingDelta`      | Net effect of `status === 'pending'` events |
| `balance` (display) | `confirmedBalance + pendingDelta`           |
| `pendingBalance`    | `pendingDelta` shown separately in amber    |

Show both in the UI so users see the optimistic total and understand what is still in flight.

---

## Architecture Reference

See [references/architecture.md](references/architecture.md) for:

- Monorepo structure (Turborepo + npm workspaces)
- Express route conventions and API contract
- Sequence conflict handling (HTTP 409 + idempotency by event `id`)
- Batch event API request/response shapes
