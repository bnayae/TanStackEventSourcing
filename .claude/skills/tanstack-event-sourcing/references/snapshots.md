# Aggregate Snapshots Reference

## Table of Contents
1. [When to add snapshots](#when-to-add-snapshots)
2. [Schema additions](#schema-additions)
3. [Prisma models](#prisma-models)
4. [PG trigger snapshot guard](#pg-trigger-snapshot-guard)
5. [TypeScript types](#typescript-types)
6. [API endpoint — all accounts](#api-endpoint--all-accounts)
7. [API endpoint — events catch-up](#api-endpoint--events-catch-up)
8. [Client bootstrap](#client-bootstrap)

---

## When to add snapshots

Add snapshots when any of these are true:
- Cold-start load time is too long because the client replays the full event log
- Auditors need point-in-time state queries (prerequisite for time-travel)
- The event log is long enough that full replay is expensive at query time

A **snapshot** is an immutable copy of aggregate state captured before each update to the aggregate table, throttled to at most once per configurable interval (default 60 s). Snapshots are **read-only auxiliary data** — the events table remains authoritative.

---

## Schema additions

```sql
-- 1. Track the client-clock timestamp of the last event applied to the aggregate
ALTER TABLE account_balances
  ADD COLUMN last_event_at BIGINT NOT NULL DEFAULT 0;

-- 2. Immutable point-in-time copies of aggregate state
CREATE TABLE balance_snapshots (
  id            BIGSERIAL    PRIMARY KEY,
  account_id    TEXT         NOT NULL,
  owner_name    TEXT         NOT NULL DEFAULT '',
  balance       NUMERIC      NOT NULL,
  last_seq      INTEGER      NOT NULL,
  last_event_at BIGINT       NOT NULL,  -- client Unix ms of the event that produced this state
  captured_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_balance_snapshots_account_time
  ON balance_snapshots (account_id, last_event_at DESC);

-- 3. Configurable throttle interval (avoids snapshot on every single event)
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_settings VALUES ('snapshot_interval_seconds', '60') ON CONFLICT DO NOTHING;
```

---

## Prisma models

```prisma
model AccountBalance {
  accountId   String   @id @map("account_id")
  ownerName   String   @default("") @map("owner_name")
  balance     Decimal  @default(0)
  lastSeq     Int      @default(0) @map("last_seq")
  lastEventAt BigInt   @default(0) @map("last_event_at")  // NEW
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

---

## PG trigger snapshot guard

Prepend this block inside `apply_event_to_balance()`, before the `CASE NEW.type` statement. Also add `last_event_at = NEW.created_at` to every branch of the existing CASE.

```sql
DECLARE
  v_interval_seconds  INTEGER;
  v_current           account_balances%ROWTYPE;
BEGIN
  -- Read configurable interval
  SELECT value::INTEGER INTO v_interval_seconds
    FROM app_settings WHERE key = 'snapshot_interval_seconds';
  v_interval_seconds := COALESCE(v_interval_seconds, 60);

  -- Ensure row exists
  INSERT INTO account_balances (account_id, owner_name, balance, last_seq, last_event_at)
  VALUES (NEW.account_id, '', 0, 0, 0)
  ON CONFLICT (account_id) DO NOTHING;

  -- Load current state
  SELECT * INTO v_current FROM account_balances WHERE account_id = NEW.account_id;

  -- Write snapshot only if row is stale (throttle guard)
  IF v_current.last_seq > 0
     AND v_current.updated_at < now() - (v_interval_seconds || ' seconds')::INTERVAL
  THEN
    INSERT INTO balance_snapshots
      (account_id, owner_name, balance, last_seq, last_event_at)
    VALUES
      (v_current.account_id, v_current.owner_name, v_current.balance,
       v_current.last_seq, v_current.last_event_at);
  END IF;

  -- ... existing CASE NEW.type block follows, each branch now also sets:
  --     last_event_at = NEW.created_at
```

---

## TypeScript types

```ts
// packages/types/src/AccountSnapshot.ts
export interface AccountSnapshot {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number; // Unix ms
}

// packages/types/src/EventsAfterSeqResponse.ts
export interface EventsAfterSeqResponse {
  accountId: string;
  events: StoredEvent[];
}
```

---

## API endpoint — all accounts

`GET /api/accounts` — returns all rows from `account_balances`. Used exclusively by the client bootstrap.

```ts
accountsRouter.get('/', async (_req, res) => {
  const balances = await prisma.accountBalance.findMany();
  res.json(balances.map(b => ({
    accountId: b.accountId,
    ownerName: b.ownerName,
    balance: Number(b.balance),
    lastSeq: b.lastSeq,
    lastEventAt: Number(b.lastEventAt),
  })));
});
```

---

## API endpoint — events catch-up

`GET /api/accounts/:id/events?afterSeq=<n>` — returns all events with `sequence_number > n`, ordered ascending. Used for client catch-up.
Without `afterSeq`, falls back to legacy behaviour (last 10, descending).

---

## Client bootstrap

`apps/web/src/sync/bootstrap.ts` — two-phase cold-start:

```ts
export async function bootstrapFromSnapshots(): Promise<string[]> {
  const snapshots = await fetch('/api/accounts').then(r => r.json()) as AccountSnapshot[];
  if (snapshots.length === 0) return [];

  const bootstrapped: string[] = [];

  for (const { accountId, lastSeq } of snapshots) {
    // Find highest seq already in IndexedDB for this account
    const localEvents = await db.events
      .where('accountId').equals(accountId)
      .sortBy('sequenceNumber');
    const localMaxSeq = localEvents.at(-1)?.sequenceNumber ?? 0;

    // Fetch only events the client is missing
    const fetchAfterSeq = Math.min(localMaxSeq, lastSeq);
    const body = await fetch(
      `/api/accounts/${accountId}/events?afterSeq=${fetchAfterSeq}`
    ).then(r => r.json()) as { events: RawEvent[] };

    if (body.events.length > 0) {
      await db.events.bulkPut(
        body.events.map(e => ({ ...e, accountId, status: 'synced', syncedAt: Date.now() }))
      );
    }
    bootstrapped.push(accountId);
  }
  return bootstrapped;
}
```

Wire into `SyncEngine.start()`:

```ts
start(): void {
  this.running = true;
  window.addEventListener('online', this.onlineListener);
  window.addEventListener('offline', this.offlineListener);
  if (this.isOnline) void this.bootstrap(); // bootstrap fires sync() when done
}

private async bootstrap(): Promise<void> {
  const ids = await bootstrapFromSnapshots();
  if (ids.length > 0) {
    for (const cb of this.onSyncCompleteCallbacks) cb(ids);
  }
  void this.sync(); // then flush any pending events as normal
}
```
