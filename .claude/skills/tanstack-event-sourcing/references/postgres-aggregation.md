# PostgreSQL Aggregation Reference

## Table of Contents
1. [Prisma Schema](#prisma-schema)
2. [Migration SQL](#migration-sql)
3. [Trigger Logic Explained](#trigger-logic-explained)
4. [Extending the Trigger for New Event Types](#extending-the-trigger-for-new-event-types)
5. [Design Decisions](#design-decisions)

---

## Prisma Schema

```prisma
// apps/api/prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Event {
  id             String   @id
  aggregateId    String   @map("aggregate_id")
  type           String
  payload        Json
  sequenceNumber Int      @map("sequence_number")
  createdAt      BigInt   @map("created_at")   // stored as BIGINT, Unix ms
  syncedAt       DateTime @default(now()) @map("synced_at")

  @@unique([aggregateId, sequenceNumber])       // enforces ordering + idempotency
  @@index([aggregateId, sequenceNumber])
  @@map("events")
}

// Materialized aggregate — updated by trigger on every INSERT
model AggregateBalance {
  aggregateId String   @id @map("aggregate_id")
  name        String   @default("") @map("name")
  balance     Decimal  @default(0)
  lastSeq     Int      @default(0) @map("last_seq")
  updatedAt   DateTime @default(now()) @map("updated_at")

  @@map("aggregate_balances")
}
```

**Note on `createdAt` type**: Use `BigInt` in Prisma for Unix ms timestamps. When reading back, convert with `Number(e.createdAt)`.

---

## Migration SQL

Full SQL for the initial migration. Run via `npx prisma migrate deploy`.

```sql
-- CreateTable: events
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "created_at" BIGINT NOT NULL,
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: aggregate_balances (materialized view)
CREATE TABLE "aggregate_balances" (
    "aggregate_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "balance" NUMERIC NOT NULL DEFAULT 0,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "aggregate_balances_pkey" PRIMARY KEY ("aggregate_id")
);

-- Unique constraint: one event per (aggregate, sequence)
CREATE UNIQUE INDEX "events_aggregate_id_sequence_number_key"
    ON "events"("aggregate_id", "sequence_number");

-- Index for fast sequence range queries
CREATE INDEX "idx_events_aggregate_seq"
    ON "events"("aggregate_id", "sequence_number");

-- Trigger function: applies each inserted event to aggregate_balances
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount     NUMERIC;
  v_ref_id     TEXT;
  v_cap_amount NUMERIC;
  v_name       TEXT;
BEGIN
  -- Upsert: ensure the aggregate row exists before updating
  INSERT INTO aggregate_balances (aggregate_id, name, balance, last_seq, updated_at)
  VALUES (NEW.aggregate_id, '', 0, 0, now())
  ON CONFLICT (aggregate_id) DO NOTHING;

  CASE NEW.type
    WHEN 'ENTITY_CREATED' THEN
      v_name := NEW.payload->>'name';
      UPDATE aggregate_balances
      SET name       = v_name,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;

    WHEN 'DEPOSITED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE aggregate_balances
      SET balance    = balance + v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;

    WHEN 'WITHDRAWN' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE aggregate_balances
      SET balance    = balance - v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;

    WHEN 'CAPTURED' THEN
      -- Two-phase operation: debit the capture amount, store referenceId in payload
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE aggregate_balances
      SET balance    = balance - v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;

    WHEN 'CAPTURE_RELEASED' THEN
      -- Reverse a prior capture by looking up the original amount
      v_ref_id := NEW.payload->>'referenceId';
      SELECT (payload->>'amount')::NUMERIC
      INTO   v_cap_amount
      FROM   events
      WHERE  aggregate_id            = NEW.aggregate_id
        AND  type                    = 'CAPTURED'
        AND  payload->>'referenceId' = v_ref_id
      LIMIT 1;

      IF v_cap_amount IS NOT NULL THEN
        UPDATE aggregate_balances
        SET balance    = balance + v_cap_amount,
            last_seq   = GREATEST(last_seq, NEW.sequence_number),
            updated_at = now()
        WHERE aggregate_id = NEW.aggregate_id;
      ELSE
        -- No matching capture found — update seq only
        UPDATE aggregate_balances
        SET last_seq   = GREATEST(last_seq, NEW.sequence_number),
            updated_at = now()
        WHERE aggregate_id = NEW.aggregate_id;
      END IF;

    ELSE
      -- Unknown event type: advance last_seq but don't crash
      UPDATE aggregate_balances
      SET last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to the events table
CREATE TRIGGER trg_apply_event_to_balance
AFTER INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION apply_event_to_balance();
```

---

## Trigger Logic Explained

| Aspect | Detail |
|---|---|
| **Fires on** | `AFTER INSERT ON events FOR EACH ROW` |
| **Idempotency** | The unique index `(aggregate_id, sequence_number)` prevents duplicate events from reaching the trigger |
| **Upsert guard** | `INSERT ... ON CONFLICT DO NOTHING` ensures the aggregate row exists before `UPDATE` |
| **`GREATEST(last_seq, ...)` ** | Handles out-of-order inserts safely (e.g. if two events inserted concurrently) |
| **ELSE fallback** | Unknown event types advance `last_seq` without crashing — forward compatible |
| **Cross-row lookup** | `CAPTURE_RELEASED` queries `events` to find the original captured amount — this is a JSONB scan limited by `aggregate_id` + `type` + `referenceId` |

---

## Extending the Trigger for New Event Types

When adding a new event type, add a `WHEN` branch to the `CASE` statement inside the trigger function:

```sql
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount NUMERIC;
  -- ... declare new variables as needed
BEGIN
  INSERT INTO aggregate_balances (aggregate_id, name, balance, last_seq, updated_at)
  VALUES (NEW.aggregate_id, '', 0, 0, now())
  ON CONFLICT (aggregate_id) DO NOTHING;

  CASE NEW.type
    -- ... existing WHEN branches ...

    WHEN 'NEW_EVENT_TYPE' THEN
      v_amount := (NEW.payload->>'fieldName')::NUMERIC;
      UPDATE aggregate_balances
      SET balance    = balance + v_amount,  -- adjust operator as needed
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;

    ELSE
      UPDATE aggregate_balances
      SET last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE aggregate_id = NEW.aggregate_id;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Then create a new Prisma migration that contains only the `CREATE OR REPLACE FUNCTION` and (optionally) `DROP TRIGGER / CREATE TRIGGER` if you need to reattach it.

```sql
-- In a new migration file:
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$ ... $$ LANGUAGE plpgsql;
-- Trigger already exists; no need to recreate unless trigger def changed
```

---

## Design Decisions

**Why a trigger instead of server-side replay?**
- Trigger fires atomically within the `INSERT` transaction — no race conditions
- `GET /api/accounts/:id/balance` reads a single pre-computed row — O(1), no event replay
- Replay would be slower and harder to keep consistent under concurrent writes

**Why `NUMERIC` for balance?**
- Avoids floating-point precision issues with financial amounts
- Prisma maps `Decimal` to `NUMERIC`; convert to `Number` only at the API response boundary

**Why `GREATEST(last_seq, ...)` instead of just assigning?**
- If two events are inserted concurrently (same aggregate, different sequences), both trigger invocations may see each other's writes; `GREATEST` makes the update monotonic

**Why not a materialized view?**
- PostgreSQL materialized views require explicit `REFRESH` — not automatically updated on inserts
- A trigger-maintained table is simpler and always current
