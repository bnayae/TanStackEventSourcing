import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const accountsRouter = Router();

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

// ─── GET /api/accounts/:accountId/events ──────────────────────────────────────

accountsRouter.get('/:accountId/events', async (req, res) => {
  const { accountId } = req.params;

  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

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
