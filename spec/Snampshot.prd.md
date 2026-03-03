# Product Requirements Document: Snapshot & Time-Travel Extension

## Overview

This document extends the base Funds Management System (see `prd.md`) with three related capabilities:

1. **Optimized initial load** — on startup the client fetches server-side aggregate snapshots and seeds the local view, then fetches only the events that occurred after the snapshot. No need to replay the full event history.
2. **Snapshot table** — before each aggregate update the backend persists the previous state to a `balance_snapshots` table, enabling point-in-time reconstruction. A staleness check avoids writing a snapshot on every single event.
3. **Time-travel queries** — the API can reconstruct the state of any account at an arbitrary past timestamp by combining the nearest prior snapshot with a bounded event replay.

---

## Goals

- Eliminate full event-history replay on app startup by leveraging server-side snapshots.
- Enable auditors and developers to query the exact account state at any past moment.
- Keep snapshot writes cheap by throttling them to at most once per configurable interval (default: 1 minute).
- Retain the append-only guarantee — no events are ever mutated or deleted.

---

## Non-Goals

- Snapshotting aggregates other than `account_balances` (extensible pattern, but only balance is in scope here).
- Client-side snapshot storage (IndexedDB already covers optimistic state; server snapshots are query-only).
- Automatic event log compaction or archival after snapshotting.
- Snapshot-based conflict resolution for multi-device sync.

---

## New Domain Concepts

### Snapshot

A **snapshot** is an immutable copy of an aggregate's state captured at a specific point in the event sequence. It records:

- The full aggregate value (balance, ownerName) at the moment of capture.
- The `sequence_number` of the last event applied (`last_seq`).
- The client-clock timestamp of that event (`last_event_at`), used as the time-travel cursor.
- The server wall-clock time the snapshot was written (`captured_at`).

Snapshots are **read-only auxiliary data** — they are never the source of truth. The `events` table remains authoritative; snapshots accelerate reads.

### Time-Travel Query

A **time-travel query** reconstructs account state at a past `unix_ms` timestamp by:

1. Finding the latest snapshot whose `last_event_at ≤ target`.
2. Replaying all events with `sequence_number > snapshot.last_seq` AND `created_at ≤ target` on top of the snapshot state.
3. Returning the resulting `AccountState`.

If no snapshot exists before the target, the query replays from the beginning of the event log.

---

## Backend Changes

### Schema Additions

#### `account_balances` — new column

Add `last_event_at BIGINT` to track the client-clock timestamp of the last event that updated the balance. The client uses this value to determine which events are "missing" (i.e., have `createdAt > last_event_at`).

```sql
ALTER TABLE account_balances
  ADD COLUMN last_event_at BIGINT NOT NULL DEFAULT 0;
```

#### `balance_snapshots` table (new)

```sql
CREATE TABLE balance_snapshots (
  id             BIGSERIAL    PRIMARY KEY,
  account_id     TEXT         NOT NULL,
  owner_name     TEXT         NOT NULL DEFAULT '',
  balance        NUMERIC      NOT NULL,
  last_seq       INTEGER      NOT NULL,
  last_event_at  BIGINT       NOT NULL,   -- client Unix ms of the event that produced this state
  captured_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_balance_snapshots_account_time
  ON balance_snapshots (account_id, last_event_at DESC);
```

#### Prisma models (additions)

```prisma
model AccountBalance {
  accountId   String   @id @map("account_id")
  ownerName   String   @default("") @map("owner_name")
  balance     Decimal  @default(0)
  lastSeq     Int      @default(0) @map("last_seq")
  lastEventAt BigInt   @default(0) @map("last_event_at")   // NEW
  updatedAt   DateTime @default(now()) @map("updated_at")

  @@map("account_balances")
}

model BalanceSnapshot {
  id          BigInt   @id @default(autoincrement())
  accountId   String   @map("account_id")
  ownerName   String   @default("") @map("owner_name")
  balance     Decimal
  lastSeq     Int      @map("last_seq")
  lastEventAt BigInt   @map("last_event_at")
  capturedAt  DateTime @default(now()) @map("captured_at")

  @@index([accountId, lastEventAt(sort: Desc)])
  @@map("balance_snapshots")
}
```

### PostgreSQL Trigger Changes

The existing `apply_event_to_balance` trigger is extended with a snapshot step. Before overwriting `account_balances`, it checks whether the current row's `captured_at` is older than a configurable threshold. If so, it inserts a snapshot first.

The threshold is stored in a lightweight settings table to avoid hard-coding it:

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_settings (key, value)
VALUES ('snapshot_interval_seconds', '60')
ON CONFLICT DO NOTHING;
```

Updated trigger function (only the snapshot guard is new; balance projection logic is unchanged):

```sql
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount              NUMERIC;
  v_captured            NUMERIC;
  v_interval_seconds    INTEGER;
  v_current             account_balances%ROWTYPE;
BEGIN
  -- Fetch configurable snapshot interval
  SELECT value::INTEGER INTO v_interval_seconds
    FROM app_settings WHERE key = 'snapshot_interval_seconds';
  v_interval_seconds := COALESCE(v_interval_seconds, 60);

  -- Ensure account row exists
  INSERT INTO account_balances (account_id, owner_name, balance, last_seq, last_event_at)
  VALUES (NEW.account_id, '', 0, 0, 0)
  ON CONFLICT (account_id) DO NOTHING;

  -- Load current state
  SELECT * INTO v_current
    FROM account_balances WHERE account_id = NEW.account_id;

  -- Write snapshot if the existing row is stale (i.e., last_seq > 0 and updated_at is old enough)
  IF v_current.last_seq > 0
     AND v_current.updated_at < now() - (v_interval_seconds || ' seconds')::INTERVAL
  THEN
    INSERT INTO balance_snapshots
      (account_id, owner_name, balance, last_seq, last_event_at)
    VALUES
      (v_current.account_id, v_current.owner_name, v_current.balance,
       v_current.last_seq, v_current.last_event_at);
  END IF;

  -- Apply event (same projection rules as before)
  CASE NEW.type
    WHEN 'ACCOUNT_CREATED' THEN
      UPDATE account_balances
         SET owner_name    = NEW.payload->>'ownerName',
             last_seq      = NEW.sequence_number,
             last_event_at = NEW.created_at,
             updated_at    = now()
       WHERE account_id = NEW.account_id;

    WHEN 'DEPOSITED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance       = balance + v_amount,
             last_seq      = NEW.sequence_number,
             last_event_at = NEW.created_at,
             updated_at    = now()
       WHERE account_id = NEW.account_id;

    WHEN 'WITHDRAWN' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance       = balance - v_amount,
             last_seq      = NEW.sequence_number,
             last_event_at = NEW.created_at,
             updated_at    = now()
       WHERE account_id = NEW.account_id;

    WHEN 'CAPTURED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
         SET balance       = balance - v_amount,
             last_seq      = NEW.sequence_number,
             last_event_at = NEW.created_at,
             updated_at    = now()
       WHERE account_id = NEW.account_id;

    WHEN 'CAPTURE_RELEASED' THEN
      SELECT (payload->>'amount')::NUMERIC INTO v_captured
        FROM events
       WHERE account_id = NEW.account_id
         AND type = 'CAPTURED'
         AND payload->>'referenceId' = NEW.payload->>'referenceId'
       LIMIT 1;

      UPDATE account_balances
         SET balance       = balance + COALESCE(v_captured, 0),
             last_seq      = NEW.sequence_number,
             last_event_at = NEW.created_at,
             updated_at    = now()
       WHERE account_id = NEW.account_id;

    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

> **Note:** The trigger is replaced in-place via a Prisma custom migration SQL file. No structural changes to the `events` table or the event insertion path are required.

---

## API Contract

### `GET /api/accounts`

Returns the current snapshot state of all accounts. The client calls this on startup to seed the UI without replaying the full event log.

#### Response `200`

```json
[
  {
    "accountId": "string",
    "ownerName": "string",
    "balance": 100,
    "lastSeq": 42,
    "lastEventAt": 1700000000000
  }
]
```

| Field          | Type     | Description                                                |
| -------------- | -------- | ---------------------------------------------------------- |
| `accountId`    | `string` | Account identifier                                         |
| `ownerName`    | `string` | Owner display name                                         |
| `balance`      | `number` | Authoritative balance from `account_balances`              |
| `lastSeq`      | `number` | Sequence number of the last event applied to this balance  |
| `lastEventAt`  | `number` | Client Unix ms timestamp of that event                     |

---

### `GET /api/accounts/:accountId/state?at=<unix_ms>`

Reconstructs the account state at the given Unix millisecond timestamp. This is the time-travel endpoint.

#### Query parameters

| Parameter | Type     | Required | Description                                     |
| --------- | -------- | -------- | ----------------------------------------------- |
| `at`      | `number` | yes      | Target Unix timestamp in milliseconds           |

#### Response `200` (time-travel)

```json
{
  "accountId": "string",
  "ownerName": "string",
  "balance": 75,
  "lastSeq": 30,
  "lastEventAt": 1699990000000,
  "snapshotId": 12,
  "eventsReplayed": 5
}
```

| Field            | Type          | Description                                                   |
| ---------------- | ------------- | ------------------------------------------------------------- |
| `accountId`      | `string`      | Account identifier                                            |
| `ownerName`      | `string`      | Owner name at the target time                                 |
| `balance`        | `number`      | Balance at the target time                                    |
| `lastSeq`        | `number`      | Last sequence number applied                                  |
| `lastEventAt`    | `number`      | Timestamp of the last event applied                           |
| `snapshotId`     | `number\|null`| ID of the base snapshot used (`null` = replayed from genesis) |
| `eventsReplayed` | `number`      | Number of events applied on top of the base snapshot          |

#### Response `404`

Account not found.

#### Response `400`

`at` parameter missing or not a valid integer.

---

### Existing endpoints (unchanged)

- `POST /api/events/batch` — no changes; trigger handles snapshot writes transparently.
- `GET /api/accounts/:accountId/balance` — no changes; still returns current balance.

---

## Client Changes

### Initial Load Optimization

On application startup (before rendering any account data), the client performs a two-phase bootstrap:

#### Phase 1 — fetch server snapshots

```http
GET /api/accounts
```

For each account in the response:

- If the account has **no local events** in IndexedDB: seed `ownerName`, `balance`, and `lastSeq` directly from the snapshot. Mark these as the "confirmed baseline" so the UI renders immediately without a replay.
- If the account has **local events beyond `lastSeq`**: apply them on top of the snapshot balance using `computeStateFromEvents` to produce the optimistic balance.
- If the account has **local events with `sequenceNumber ≤ lastSeq`**: those events are already included in the server balance; skip them in the optimistic replay.

#### Phase 2 — fetch missing events (if any)

After seeding from snapshots, fetch events not yet in IndexedDB:

```http
GET /api/accounts/:id/events?afterSeq=<lastSeq>
```

> This endpoint is new but simple: `SELECT * FROM events WHERE account_id = $1 AND sequence_number > $2 ORDER BY sequence_number`.

Apply fetched events via `computeStateFromEvents` and upsert them into IndexedDB with `status: 'synced'`.

**Result:** On a cold start the client loads the current balance in O(1) network round trips regardless of event log length.

### Time-Travel UI

A date-time picker is added to the **Account Detail** screen (`/accounts/:id`).

- When a time is selected, the UI calls `GET /api/accounts/:id/state?at=<unix_ms>` via TanStack Query.
- The result is rendered as a **read-only historical view** alongside the current balance:
  - "Balance on \<date\>: \$75" (historical)
  - "Current balance: \$120" (live)
- The historical view is visually distinct (e.g., a muted banner or timeline marker).
- Clearing the time selection returns to the live view.
- While fetching, a loading state is shown; errors are surfaced inline.

---

## TypeScript Types

The following types are added to `packages/types/src/index.ts`:

```ts
/** One entry from GET /api/accounts */
export interface AccountSnapshot {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number;  // Unix ms
}

/** Response from GET /api/accounts/:id/state?at=<unix_ms> */
export interface TimeTravelResponse {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number;  // Unix ms
  snapshotId: number | null;
  eventsReplayed: number;
}

/** Response from GET /api/accounts/:id/events?afterSeq=<n> */
export interface EventsAfterSeqResponse {
  accountId: string;
  events: StoredEvent[];
}
```

---

## Acceptance Criteria

1. **Snapshot on stale trigger**: After inserting events spaced more than 1 minute apart (simulated), a row appears in `balance_snapshots` between the two batches.
2. **No snapshot on rapid events**: Inserting 10 events within 1 second produces at most 1 snapshot row (the staleness guard fires at most once per interval).
3. **Configurable interval**: Setting `app_settings.snapshot_interval_seconds = 5` causes snapshots to be written every 5+ seconds of event activity.
4. **Optimized initial load**: On a cold client start, `GET /api/accounts` is called before any IndexedDB event replay. The UI renders account balances without reading any events from IndexedDB (when no local pending events exist).
5. **Missing events fetched**: If the server's `lastSeq` is ahead of the client's local event log, the client fetches and stores the missing events via `GET /api/accounts/:id/events?afterSeq=<n>`.
6. **Time-travel accuracy**: `GET /api/accounts/:id/state?at=T` returns the same balance as would be computed by replaying all events with `created_at ≤ T` from scratch.
7. **Time-travel UI**: The Account Detail screen has a date-time picker; selecting a past time renders the historical balance without navigating away.
8. **No data mutation**: No events are modified or deleted by any snapshot-related operation.
9. **Backward compatibility**: All existing acceptance criteria from `prd.md` continue to pass unchanged.

---

## Out of Scope

- Snapshotting aggregates other than `account_balances`.
- Client-side (IndexedDB) snapshot storage.
- Automatic event log compaction or truncation after snapshotting.
- Snapshot invalidation or recomputation on event deletion.
- Multi-account time-travel (batch point-in-time queries).
- Exporting or streaming snapshot diffs.
