# Time-Travel Reference

**Prerequisite:** Snapshots feature must be implemented first (see [snapshots.md](snapshots.md)). Time-travel uses `balance_snapshots` as a fast seek point; without them it replays from genesis on every query.

## Table of Contents
1. [TypeScript types](#typescript-types)
2. [API endpoint — time-travel state](#api-endpoint--time-travel-state)
3. [TimeTravelPanel component](#timetravelpanel-component)
4. [Cursor navigation](#cursor-navigation)
5. [Event list slice](#event-list-slice)

---

## TypeScript types

```ts
// packages/types/src/TimeTravelResponse.ts
export interface TimeTravelResponse {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  lastEventAt: number;
  snapshotId: number | null;
  eventsReplayed: number;
}
```

`snapshotId: null` = replayed from genesis (no prior snapshot found).

---

## API endpoint — time-travel state

`GET /api/accounts/:id/state?at=<unix_ms>` — reconstruct aggregate state at an arbitrary past timestamp.

**Algorithm:**
1. Find latest `balance_snapshots` row where `last_event_at ≤ target`.
2. Fetch `events` where `sequence_number > snapshot.last_seq AND created_at ≤ target`, ordered ascending.
3. Replay in the same projection logic as the trigger (CASE on `type`, `CAPTURE_RELEASED` uses `$queryRaw` to look up matching CAPTURED amount by `referenceId`).
4. Return `{ accountId, ownerName, balance, lastSeq, lastEventAt, snapshotId: number|null, eventsReplayed: number }`.

```ts
accountsRouter.get('/:id/state', async (req, res) => {
  const { id } = req.params;
  const atMs = Number(req.query['at']);
  if (!isFinite(atMs)) return res.status(400).json({ error: 'at must be a Unix ms timestamp' });

  // Step 1: nearest snapshot at or before target
  const snap = await prisma.balanceSnapshot.findFirst({
    where: { accountId: id, lastEventAt: { lte: atMs } },
    orderBy: { lastEventAt: 'desc' },
  });

  // Step 2: events after snapshot up to target
  const events = await prisma.event.findMany({
    where: {
      accountId: id,
      sequenceNumber: { gt: snap?.lastSeq ?? 0 },
      createdAt: { lte: atMs },
    },
    orderBy: { sequenceNumber: 'asc' },
  });

  // Step 3: replay
  let balance = Number(snap?.balance ?? 0);
  let ownerName = snap?.ownerName ?? '';
  let lastSeq = snap?.lastSeq ?? 0;
  let lastEventAt = Number(snap?.lastEventAt ?? 0);

  for (const e of events) {
    lastSeq = e.sequenceNumber;
    lastEventAt = e.createdAt;
    switch (e.type) {
      case 'ACCOUNT_CREATED':  ownerName = (e.payload as any).ownerName; break;
      case 'DEPOSITED':        balance += (e.payload as any).amount; break;
      case 'WITHDRAWN':        balance -= (e.payload as any).amount; break;
      case 'CAPTURED':         balance -= (e.payload as any).amount; break;
      case 'CAPTURE_RELEASED': {
        const [orig] = await prisma.$queryRaw<{amount: number}[]>`
          SELECT (payload->>'amount')::numeric AS amount
          FROM events
          WHERE account_id = ${id}
            AND type = 'CAPTURED'
            AND payload->>'referenceId' = ${(e.payload as any).referenceId}
          LIMIT 1`;
        if (orig) balance += orig.amount;
        break;
      }
    }
  }

  res.json({
    accountId: id,
    ownerName,
    balance,
    lastSeq,
    lastEventAt,
    snapshotId: snap ? Number(snap.id) : null,
    eventsReplayed: events.length,
  });
});
```

---

## TimeTravelPanel component

### Props
```ts
interface TimeTravelPanelProps {
  accountId: string;
  currentBalance: number;
  events: StoredEvent[];  // full local event list including pending
}
```

### Three input modes (all resolve to `targetMs: number | null`)

| Mode | Input | Resolution |
|------|-------|------------|
| Date & Time | `datetime-local` | `new Date(value).getTime()` |
| N Events Back | number field | `syncedEvents[Math.max(0, length - n)].createdAt` |
| Duration Back | `HH:mm:ss` | `Date.now() - parsedMs` |

`parseDurationMs("HH:mm:ss")` — split on `:`, parse to `(h*3600 + m*60 + s)*1000`. Return `null` if any part is out of range (m > 59, s > 59, non-finite).

All three modes feed one TanStack Query:
```ts
useQuery({
  queryKey: ['time-travel', accountId, targetMs],
  queryFn: () => fetchTimeTravelState(accountId, targetMs!),
  enabled: targetMs !== null,
  staleTime: Infinity, // historical data is immutable
})
```

### syncedEvents — the navigable timeline
```ts
const syncedEvents = useMemo(
  () => events
    .filter(e => e.status === 'synced')
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber),
  [events]
);
// Only synced events participate — pending events are not yet on the server
```

### targetMs derivation
```ts
/** ms from the input controls (ignores cursor navigation). */
const inputTargetMs = useMemo<number | null>(() => { /* mode switch */ }, [...]);

/**
 * Actual query target:
 * - If cursor is set (navigation), use the cursor event's createdAt.
 * - Otherwise fall back to input-derived ms.
 */
const targetMs = useMemo<number | null>(() => {
  if (cursorIndex !== null) return syncedEvents[cursorIndex]?.createdAt ?? null;
  return inputTargetMs;
}, [cursorIndex, syncedEvents, inputTargetMs]);
```

---

## Cursor navigation

```ts
const [cursorIndex, setCursorIndex] = useState<number | null>(null);

// Seed cursor when first result arrives
useEffect(() => {
  if (!data) return;
  const idx = syncedEvents.findIndex(e => e.sequenceNumber === data.lastSeq);
  if (idx !== -1) setCursorIndex(idx);
}, [data, syncedEvents]);

// Reset cursor when inputs change (new query being entered)
useEffect(() => { setCursorIndex(null); }, [inputTargetMs]);
```

When `cursorIndex` is set, `targetMs` is derived from `syncedEvents[cursorIndex].createdAt` — so ← / → navigation triggers new queries without touching any input field.

Navigation boundaries:
```ts
const atFirst = cursorIndex !== null && cursorIndex <= 0;
const atLast  = cursorIndex !== null && cursorIndex >= syncedEvents.length - 1;

function goBack()    { setCursorIndex(prev => prev === null ? null : Math.max(0, prev - 1)); }
function goForward() { setCursorIndex(prev => prev === null ? null : Math.min(syncedEvents.length - 1, prev + 1)); }
```

### Rules
- Cursor resets to `null` whenever `inputTargetMs` changes
- Switching mode calls `handleClear()` which resets all input state and the cursor
- The cursor event row gets an amber highlight + `current` badge

---

## Event list slice

```ts
const visibleEvents = useMemo(() => {
  if (cursorIndex === null) return [];
  const end = cursorIndex + 1;
  const start = Math.max(0, end - showCount);
  return syncedEvents.slice(start, end);
}, [cursorIndex, syncedEvents, showCount]);
// Rendered reversed (most recent first). showCount: 5|10|25|50, default 10.
```

`eventSummary(e)` formats payload:
- `ACCOUNT_CREATED` → `Created — Alice`
- `DEPOSITED` → `Deposit +$100.00`
- `WITHDRAWN` → `Withdrawal −$50.00`
- `CAPTURED` → `Capture −$25.00`
- `CAPTURE_RELEASED` → `Release ref:abc12345`
