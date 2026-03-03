import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const accountsRouter = Router();

// ─── GET /api/accounts ────────────────────────────────────────────────────────
// Returns current snapshot state for all accounts (used by client for bootstrap).

accountsRouter.get('/', async (_req, res) => {
  try {
    const balances = await prisma.accountBalance.findMany();

    res.status(200).json(
      balances.map(b => ({
        accountId: b.accountId,
        ownerName: b.ownerName,
        balance: Number(b.balance),
        lastSeq: b.lastSeq,
        lastEventAt: Number(b.lastEventAt),
      }))
    );
  } catch (err) {
    console.error('[accounts] Error fetching all accounts:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ─── GET /api/accounts/:accountId/state?at=<unix_ms> ─────────────────────────
// Time-travel: reconstruct account state at a past Unix ms timestamp.

accountsRouter.get('/:accountId/state', async (req, res) => {
  const { accountId } = req.params;
  const atParam = req.query['at'];

  if (typeof atParam !== 'string' || !/^\d+$/.test(atParam)) {
    res.status(400).json({ error: '`at` query parameter must be a valid integer Unix ms timestamp' });
    return;
  }

  const targetMs = parseInt(atParam, 10);

  try {
    // 1. Find latest snapshot with last_event_at <= target
    const snapshot = await prisma.balanceSnapshot.findFirst({
      where: { accountId, lastEventAt: { lte: targetMs } },
      orderBy: { lastEventAt: 'desc' },
    });

    const baseLastSeq = snapshot?.lastSeq ?? 0;

    // 2. Fetch events after the snapshot up to the target timestamp
    const rawEvents = await prisma.event.findMany({
      where: {
        accountId,
        sequenceNumber: { gt: baseLastSeq },
        createdAt: { lte: targetMs },
      },
      orderBy: { sequenceNumber: 'asc' },
    });

    // Verify account exists at all
    const accountExists =
      snapshot !== null ||
      rawEvents.length > 0 ||
      (await prisma.accountBalance.findUnique({ where: { accountId } })) !== null;

    if (!accountExists) {
      res.status(404).json({ error: 'Account not found', accountId });
      return;
    }

    // 3. Seed state from snapshot (or zero)
    let ownerName = snapshot?.ownerName ?? '';
    let balance = Number(snapshot?.balance ?? 0);
    let lastSeq = baseLastSeq;
    let lastEventAt = Number(snapshot?.lastEventAt ?? 0);

    // 4. Replay events on top of the snapshot
    for (const e of rawEvents) {
      const payload = e.payload as Record<string, unknown>;
      lastSeq = e.sequenceNumber;
      lastEventAt = Number(e.createdAt);

      switch (e.type) {
        case 'ACCOUNT_CREATED':
          ownerName = typeof payload['ownerName'] === 'string' ? payload['ownerName'] : ownerName;
          break;
        case 'DEPOSITED':
          balance += Number(payload['amount'] ?? 0);
          break;
        case 'WITHDRAWN':
          balance -= Number(payload['amount'] ?? 0);
          break;
        case 'CAPTURED':
          balance -= Number(payload['amount'] ?? 0);
          break;
        case 'CAPTURE_RELEASED': {
          const refId = payload['referenceId'];
          const capturedRows = await prisma.$queryRaw<Array<{ amount: string }>>`
            SELECT (payload->>'amount')::numeric AS amount
            FROM events
            WHERE account_id = ${accountId}
              AND type = 'CAPTURED'
              AND payload->>'referenceId' = ${refId as string}
            LIMIT 1
          `;
          if (capturedRows[0] !== undefined) {
            balance += Number(capturedRows[0].amount);
          }
          break;
        }
        default:
          break;
      }
    }

    res.status(200).json({
      accountId,
      ownerName,
      balance,
      lastSeq,
      lastEventAt,
      snapshotId: snapshot !== null ? Number(snapshot.id) : null,
      eventsReplayed: rawEvents.length,
    });
  } catch (err) {
    console.error(`[accounts] Error fetching state for ${accountId} at ${targetMs}:`, err);
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ─── GET /api/accounts/:accountId/events ──────────────────────────────────────
// With ?afterSeq=<n>: returns all events with sequence_number > n (ascending).
// Without afterSeq:   returns last 10 events descending (legacy behaviour).

accountsRouter.get('/:accountId/events', async (req, res) => {
  const { accountId } = req.params;
  const afterSeqParam = req.query['afterSeq'];

  if (afterSeqParam !== undefined) {
    if (typeof afterSeqParam !== 'string' || !/^\d+$/.test(afterSeqParam)) {
      res.status(400).json({ error: '`afterSeq` must be a non-negative integer' });
      return;
    }

    const afterSeq = parseInt(afterSeqParam, 10);

    try {
      const events = await prisma.event.findMany({
        where: { accountId, sequenceNumber: { gt: afterSeq } },
        orderBy: { sequenceNumber: 'asc' },
      });

      res.status(200).json({
        accountId,
        events: events.map(e => ({
          id: e.id,
          type: e.type,
          payload: e.payload,
          sequenceNumber: e.sequenceNumber,
          createdAt: Number(e.createdAt),
        })),
      });
    } catch (err) {
      console.error(`[accounts] Error fetching events afterSeq=${afterSeq} for ${accountId}:`, err);
      res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
    return;
  }

  // Legacy: no afterSeq → last 10 descending
  try {
    const events = await prisma.event.findMany({
      where: { accountId },
      orderBy: { sequenceNumber: 'desc' },
      take: 10,
    });

    res.status(200).json({
      accountId,
      events: events.map(e => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        sequenceNumber: e.sequenceNumber,
        createdAt: Number(e.createdAt),
      })),
    });
  } catch (err) {
    console.error(`[accounts] Error fetching events for ${accountId}:`, err);
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ─── DELETE /api/accounts/:accountId ─────────────────────────────────────────

accountsRouter.delete('/:accountId', async (req, res) => {
  const { accountId } = req.params;

  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

  try {
    await prisma.$transaction([
      prisma.event.deleteMany({ where: { accountId } }),
      prisma.accountBalance.deleteMany({ where: { accountId } }),
    ]);

    res.status(200).json({ accountId, deleted: true });
  } catch (err) {
    console.error(`[accounts] Error deleting account ${accountId}:`, err);
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ─── GET /api/accounts/:accountId/balance ─────────────────────────────────────

accountsRouter.get('/:accountId/balance', async (req, res) => {
  const { accountId } = req.params;

  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

  try {
    const accountBalance = await prisma.accountBalance.findUnique({
      where: { accountId },
    });

    if (accountBalance === null) {
      res.status(404).json({
        error: 'Account not found',
        accountId,
      });
      return;
    }

    res.status(200).json({
      accountId: accountBalance.accountId,
      ownerName: accountBalance.ownerName,
      balance: Number(accountBalance.balance),
      lastSeq: accountBalance.lastSeq,
      updatedAt: accountBalance.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error(`[accounts] Error fetching balance for ${accountId}:`, err);
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});
