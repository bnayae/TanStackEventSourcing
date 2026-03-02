import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export const eventsRouter = Router();

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const BatchEventItemSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().uuid(),
    type: z.literal('ACCOUNT_CREATED'),
    payload: z.object({ ownerName: z.string() }),
    createdAt: z.number().int().positive(),
    sequenceNumber: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('DEPOSITED'),
    payload: z.object({ amount: z.number().positive() }),
    createdAt: z.number().int().positive(),
    sequenceNumber: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('WITHDRAWN'),
    payload: z.object({ amount: z.number().positive() }),
    createdAt: z.number().int().positive(),
    sequenceNumber: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('CAPTURED'),
    payload: z.object({ amount: z.number().positive(), referenceId: z.string() }),
    createdAt: z.number().int().positive(),
    sequenceNumber: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('CAPTURE_RELEASED'),
    payload: z.object({ referenceId: z.string() }),
    createdAt: z.number().int().positive(),
    sequenceNumber: z.number().int().nonnegative(),
  }),
]);

const BatchEventsRequestSchema = z.object({
  accountId: z.string().uuid(),
  events: z.array(BatchEventItemSchema).min(1),
});

// ─── POST /api/events/batch ───────────────────────────────────────────────────

eventsRouter.post('/batch', async (req, res) => {
  const parseResult = BatchEventsRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    res.status(400).json({
      error: 'Validation error',
      details: parseResult.error.flatten(),
    });
    return;
  }

  const { accountId, events } = parseResult.data;

  // Sort events by sequenceNumber to ensure correct ordering
  const sortedEvents = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const accepted: string[] = [];
  const rejected: string[] = [];

  // Process events one at a time in order
  for (const event of sortedEvents) {
    try {
      await prisma.event.create({
        data: {
          id: event.id,
          accountId,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
          sequenceNumber: event.sequenceNumber,
          createdAt: BigInt(event.createdAt),
        },
      });
      accepted.push(event.id);
    } catch (err) {
      // Unique constraint violation (account_id, sequence_number) = sequence conflict
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Check if it's an idempotent duplicate (same id already exists)
        try {
          const existing = await prisma.event.findUnique({
            where: { id: event.id },
          });
          if (existing !== null) {
            // Already accepted — treat as accepted (idempotent)
            accepted.push(event.id);
          } else {
            // Different event with same sequence number = conflict
            rejected.push(event.id);
          }
        } catch {
          rejected.push(event.id);
        }
      } else {
        console.error(`[events/batch] Error inserting event ${event.id}:`, err);
        rejected.push(event.id);
      }
    }
  }

  // If any events were rejected due to sequence conflicts, return 409
  if (rejected.length > 0 && accepted.length === 0) {
    res.status(409).json({
      error: 'Sequence conflict',
      accepted,
      rejected,
    });
    return;
  }

  // Get the updated server balance
  const accountBalance = await prisma.accountBalance.findUnique({
    where: { accountId },
  });

  const serverBalance = accountBalance
    ? Number(accountBalance.balance)
    : 0;

  res.status(200).json({
    accepted,
    rejected,
    serverBalance,
  });
});
