# Product Requirements Document: Funds Management System

## Overview

A client-side funds management application built with TanStack libraries, implementing an event-sourcing architecture with offline-first capability. The system records financial events locally, persists them to IndexedDB via [Dexie.js](https://dexie.org), and syncs them to the backend in creation order when connectivity is restored. The backend stores events in PostgreSQL and uses a materialized view pipeline to derive authoritative account balances.

---

## Goals

- Demonstrate TanStack ecosystem capabilities (Query, Router, DB) in a real-world scenario.
- Implement event sourcing end-to-end: client records events, backend stores and replays them.
- Support full offline operation with transparent sync upon reconnection.
- Guarantee server-side event ordering matches client-side creation order.
- Derive authoritative balance on the backend via a PostgreSQL materialization pipeline.

---

## Non-Goals

- Multi-user / multi-device conflict resolution (out of scope for this playground).
- Authentication and authorization.
- Third-party event sourcing frameworks (KISS raw implementation only).

---

## Domain Model

### Events

All state changes are expressed as immutable events. Each event has the following base shape:

```ts
interface BaseEvent {
  id: string;             // UUID, generated client-side
  type: EventType;
  accountId: string;
  createdAt: number;      // Unix timestamp ms, client clock
  syncedAt?: number;      // Set by backend upon successful sync
  status: 'pending' | 'synced' | 'failed';
  sequenceNumber: number; // Client-assigned monotonically increasing integer per account
}
```

#### Event Types

| Type                | Payload                                   | Description                                          |
| ------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `ACCOUNT_CREATED`   | `{ ownerName: string }`                   | Opens a new account with zero balance                |
| `DEPOSITED`         | `{ amount: number }`                      | Credits the account                                  |
| `WITHDRAWN`         | `{ amount: number }`                      | Debits the account (fails if insufficient funds)     |
| `CAPTURED`          | `{ amount: number, referenceId: string }` | Reserves and settles a pre-authorized amount         |
| `CAPTURE_RELEASED`  | `{ referenceId: string }`                 | Cancels a prior capture and returns funds to balance |

### Derived State

State is **never stored directly** — it is computed by replaying the event log.

```ts
interface AccountState {
  accountId: string;
  ownerName: string;
  balance: number;        // Authoritative balance from backend materialized view
  pendingBalance: number; // Optimistic balance including client-side pending events
}
```

---

## Architecture

### Layers

```text
UI (React + TanStack Router)
  ↕
TanStack Query  ←→  Optimistic State (derived from local event log)
  ↕
Event Store (TanStack DB / Dexie → IndexedDB)
  ↕
Sync Engine (background worker / queue)
  ↕
Backend API (Node.js + Express)
  ↕
Prisma ORM
  ↕
PostgreSQL
  ├── events          (append-only event log)
  └── account_balances (materialized view — auto-updated via trigger)
```

### Client Event Store Schema (Dexie / IndexedDB)

```ts
// Table: events
{
  id: string;             // Primary key (UUID)
  accountId: string;      // Index
  type: EventType;
  payload: object;
  createdAt: number;      // Index (sort key)
  sequenceNumber: number; // Index, scoped per accountId
  status: 'pending' | 'synced' | 'failed';
  syncedAt?: number;
}
```

---

## Backend: Event Sourcing Implementation

### Design Principles

- **No event sourcing library** — raw SQL + Prisma only.
- **Single append-only table** (`events`) — records are never updated or deleted.
- **Insertion order = client sequence order** — the batch endpoint inserts events strictly in the `sequenceNumber` order received.
- **State materialization via PostgreSQL** — a trigger function recalculates the `account_balances` row after every insert into `events`.

### PostgreSQL Schema

#### `events` table (managed by Prisma)

```sql
CREATE TABLE events (
  id              TEXT PRIMARY KEY,           -- client UUID
  account_id      TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,       -- event-specific data
  sequence_number INTEGER     NOT NULL,
  created_at      BIGINT      NOT NULL,       -- client Unix ms
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, sequence_number)
);

CREATE INDEX idx_events_account_seq ON events (account_id, sequence_number);
```

#### `account_balances` table (materialized state)

```sql
CREATE TABLE account_balances (
  account_id  TEXT PRIMARY KEY,
  owner_name  TEXT    NOT NULL DEFAULT '',
  balance     NUMERIC NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### PostgreSQL trigger pipeline

A `AFTER INSERT` trigger on `events` upserts the `account_balances` row by applying the projection rules inline:

```sql
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount   NUMERIC;
  v_captured NUMERIC;
BEGIN
  -- Upsert account row on first event
  INSERT INTO account_balances (account_id, owner_name, balance, last_seq)
  VALUES (NEW.account_id, '', 0, 0)
  ON CONFLICT (account_id) DO NOTHING;

  CASE NEW.type
    WHEN 'ACCOUNT_CREATED' THEN
      UPDATE account_balances
         SET owner_name = NEW.payload->>'ownerName',
             last_seq   = NEW.sequence_number,
             updated_at = now()
       WHERE account_id = NEW.account_id;

    WHEN 'DEPOSITED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance    = balance + v_amount,
             last_seq   = NEW.sequence_number,
             updated_at = now()
       WHERE account_id = NEW.account_id;

    WHEN 'WITHDRAWN' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance    = balance - v_amount,
             last_seq   = NEW.sequence_number,
             updated_at = now()
       WHERE account_id = NEW.account_id;

    WHEN 'CAPTURED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance    = balance - v_amount,
             last_seq   = NEW.sequence_number,
             updated_at = now()
       WHERE account_id = NEW.account_id;

    WHEN 'CAPTURE_RELEASED' THEN
      -- Look up the original CAPTURED amount by referenceId
      SELECT (payload->>'amount')::NUMERIC INTO v_captured
        FROM events
       WHERE account_id = NEW.account_id
         AND type       = 'CAPTURED'
         AND payload->>'referenceId' = NEW.payload->>'referenceId'
       LIMIT 1;

      UPDATE account_balances
         SET balance    = balance + COALESCE(v_captured, 0),
             last_seq   = NEW.sequence_number,
             updated_at = now()
       WHERE account_id = NEW.account_id;

    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_event
AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION apply_event_to_balance();
```

The trigger SQL is executed as an init script inside Docker Compose (see [Infrastructure](#infrastructure)).

### Prisma Schema

```prisma
// prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Event {
  id             String   @id
  accountId      String   @map("account_id")
  type           String
  payload        Json
  sequenceNumber Int      @map("sequence_number")
  createdAt      BigInt   @map("created_at")
  syncedAt       DateTime @default(now()) @map("synced_at")

  @@unique([accountId, sequenceNumber])
  @@index([accountId, sequenceNumber])
  @@map("events")
}

model AccountBalance {
  accountId String   @id @map("account_id")
  ownerName String   @default("") @map("owner_name")
  balance   Decimal  @default(0)
  lastSeq   Int      @default(0) @map("last_seq")
  updatedAt DateTime @default(now()) @map("updated_at")

  @@map("account_balances")
}
```

> Prisma manages table DDL via migrations. The trigger and index are added in a custom migration SQL file (`prisma/migrations/<timestamp>_add_balance_trigger/migration.sql`).

---

## Infrastructure

### Docker Compose

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: funds
      POSTGRES_PASSWORD: funds
      POSTGRES_DB: funds
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d   # runs *.sql on first start

volumes:
  postgres_data:
```

`db/init/01_trigger.sql` — contains the trigger DDL above. Prisma migrations handle table creation; the trigger file runs after Prisma `migrate deploy` via an entrypoint script or manually.

> **Run order**: `docker compose up -d` → `npx prisma migrate deploy` → trigger is applied via migration SQL.

---

## Offline-First Behavior

### Writing Events

1. Client generates a UUID and `sequenceNumber` for the event.
2. Event is written to IndexedDB with `status: 'pending'`.
3. UI updates optimistically by replaying all local events (pending + synced).
4. Sync engine attempts to flush pending events to the backend.

### Sync Engine

- Runs as a background process (Web Worker or `online` event listener).
- Reads all `status: 'pending'` events ordered by `(accountId, sequenceNumber)`.
- Sends events to the backend in a single ordered batch per account.
- On success: marks events `status: 'synced'`, stores `syncedAt`.
- On failure: retries with exponential backoff; marks as `status: 'failed'` after N retries.
- Guarantees **ordering**: the backend inserts events in the exact `sequenceNumber` order received.

### Connectivity Detection

- Listen to `window.online` / `window.offline` browser events.
- Expose a `useNetworkStatus()` hook for UI indicators.
- TanStack Query's `networkMode: 'offlineFirst'` for all mutations.

---

## State Computation Rules

The **PostgreSQL trigger** (authoritative) and the **client pure function** (optimistic) share identical projection rules:

```text
INITIAL: balance = 0
ACCOUNT_CREATED   → no balance change; registers ownerName
DEPOSITED(amount) → balance += amount
WITHDRAWN(amount) → balance -= amount         (reject if amount > balance)
CAPTURED(amount)  → balance -= amount         (reject if amount > balance)
CAPTURE_RELEASED(referenceId) → balance += capturedAmount  (reverses the matching CAPTURED)
```

The client uses the same logic on its local event log for the optimistic balance shown before sync.

---

## API Contract

### `POST /api/events/batch`

Inserts an ordered batch of events for a single account. Events are written to the `events` table in the received order; the PostgreSQL trigger updates `account_balances` after each insert.

#### Request

```json
{
  "accountId": "string",
  "events": [
    {
      "id": "uuid",
      "type": "DEPOSITED",
      "payload": { "amount": 100 },
      "createdAt": 1700000000000,
      "sequenceNumber": 1
    }
  ]
}
```

#### Response `200`

```json
{
  "accepted": ["uuid"],
  "rejected": [],
  "serverBalance": 100
}
```

#### Response `409`

Sequence conflict — gap or duplicate `sequenceNumber` detected.

---

### `GET /api/accounts/:accountId/balance`

Returns the authoritative balance from the `account_balances` materialized view.

#### Balance Response `200`

```json
{
  "accountId": "string",
  "ownerName": "string",
  "balance": 100,
  "lastSeq": 5,
  "updatedAt": "2024-11-15T10:00:00Z"
}
```

---

## UI Requirements

### Screens

| Screen           | Path                      | Description                                              |
| ---------------- | ------------------------- | -------------------------------------------------------- |
| Account List     | `/`                       | Lists all accounts with optimistic balance               |
| Account Detail   | `/accounts/:id`           | Shows event history, optimistic balance, server balance  |
| New Account      | `/accounts/new`           | Form to create an account                                |
| Server Balance   | `/accounts/:id/balance`   | Fetches and displays the authoritative backend balance   |

### Components

- `<AccountCard>` — displays account ID, owner, optimistic balance, pending indicator.
- `<EventList>` — ordered list of events with status badges (pending / synced / failed).
- `<DepositForm>`, `<WithdrawalForm>`, `<CaptureForm>`, `<ReleaseCaptureForm>` — event creation forms.
- `<NetworkStatusBanner>` — shows offline/syncing/online state.
- `<ServerBalance>` — fetches `GET /api/accounts/:id/balance` and displays the authoritative balance alongside the optimistic balance for comparison.

### UX Rules

- Pending events must be visually distinguishable from synced events.
- Optimistic balance is shown immediately; server balance is loaded separately via TanStack Query.
- The `<ServerBalance>` component displays both values side-by-side with a clear label ("Optimistic" vs "Confirmed").
- Disable destructive actions (`WITHDRAWN`, `CAPTURED`) when computed balance would go negative.
- Display a sync status indicator: "N events pending sync".

---

## Tech Stack

| Concern              | Library / Tool                           |
| -------------------- | ---------------------------------------- |
| Monorepo             | Turborepo                                |
| Language             | TypeScript 5 (strict, project references)|
| Framework            | React 19                                 |
| Routing              | TanStack Router                          |
| Server state         | TanStack Query                           |
| Local persistence    | TanStack DB (Dexie adapter) + IndexedDB  |
| Styling              | Tailwind CSS                             |
| Build (client)       | Vite                                     |
| Build (server)       | tsc / tsx                                |
| Testing              | Vitest + Testing Library                 |
| Backend runtime      | Node.js + Express                        |
| ORM                  | Prisma                                   |
| Database             | PostgreSQL 16                            |
| Containerization     | Docker Compose                           |

---

## Monorepo Structure (Turborepo)

```text
/
├── turbo.json
├── package.json          (root — workspaces)
├── tsconfig.base.json    (shared TS base config)
├── packages/
│   └── types/            (shared domain types & event definitions)
│       ├── package.json
│       └── src/index.ts
├── apps/
│   ├── web/              (React client — Vite)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── api/              (Node.js + Express backend)
│       ├── package.json
│       ├── prisma/
│       │   └── schema.prisma
│       └── tsconfig.json
└── docker-compose.yml
```

- `packages/types` is the single source of truth for `EventType`, `BaseEvent`, and payload interfaces — imported by both `apps/web` and `apps/api`.
- Turbo pipeline: `build` depends on `^build` (types built before apps); `dev` runs all apps in watch mode concurrently.

---

## TypeScript Standards

The following rules apply across all packages and apps:

- `"strict": true` in every `tsconfig.json` — no exceptions.
- `"noUncheckedIndexedAccess": true` — array/object index access always returns `T | undefined`.
- `"exactOptionalPropertyTypes": true` — optional properties must not be assigned `undefined` explicitly.
- `"noImplicitReturns": true` and `"noFallthroughCasesInSwitch": true`.
- **No `any`** — use `unknown` and narrow with type guards. ESLint rule `@typescript-eslint/no-explicit-any: error`.
- **Discriminated unions** for event types — exhaustive `switch` statements enforced via `never` checks.
- Shared types live exclusively in `packages/types`; apps must not redefine domain types locally.
- All async functions return `Promise<T>` with explicit return types — no inferred `Promise<any>`.
- `zod` used at API boundaries (request body validation) to parse and type-narrow incoming JSON.

---

## Acceptance Criteria

1. **Offline write**: A user can create events with no network connection; events persist across page reloads.
2. **Optimistic balance**: The UI immediately reflects deposits/withdrawals before sync.
3. **Ordered sync**: After reconnection, the backend receives and inserts events in the exact `sequenceNumber` order they were created.
4. **Server-side materialization**: The PostgreSQL trigger recalculates `account_balances` automatically on every insert — no application-layer balance calculation.
5. **Server balance screen**: The UI can fetch and display the authoritative balance from `GET /api/accounts/:id/balance`.
6. **Failure visibility**: Failed sync events are marked and surfaced in the UI.
7. **No data loss**: Closing and reopening the app while offline does not lose pending events.
8. **Docker Compose**: `docker compose up` starts a working PostgreSQL instance with trigger initialized.

---

## Out of Scope

- Real authentication.
- Multi-tab synchronization (single tab assumed).
- Event schema versioning / migrations beyond initial setup.
- Event stream replay API (full re-projection from raw events) — balance is always read from the materialized view.
