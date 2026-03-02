import type { FundsEvent } from './FundsEvent.js';
import type { ComputeStateResult } from './ComputeStateResult.js';

/**
 * Replays a sequence of events (ordered by sequenceNumber) to compute account state.
 * This is the canonical state machine shared by both client and server.
 */
export function computeStateFromEvents(
  accountId: string,
  events: readonly FundsEvent[]
): ComputeStateResult & { ownerName: string } {
  let ownerName = '';
  let balance = 0;

  // Map from referenceId to captured amount for CAPTURE_RELEASED
  const captures = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case 'ACCOUNT_CREATED':
        ownerName = event.payload.ownerName;
        break;
      case 'DEPOSITED':
        balance += event.payload.amount;
        break;
      case 'WITHDRAWN':
        balance -= event.payload.amount;
        break;
      case 'CAPTURED':
        captures.set(event.payload.referenceId, event.payload.amount);
        balance -= event.payload.amount;
        break;
      case 'CAPTURE_RELEASED': {
        const capturedAmount = captures.get(event.payload.referenceId) ?? 0;
        balance += capturedAmount;
        captures.delete(event.payload.referenceId);
        break;
      }
      default: {
        // Exhaustive check
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    accountId,
    ownerName,
    confirmedBalance: balance,
    optimisticBalance: balance,
  };
}
