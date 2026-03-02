import type { StoredEvent, AccountState } from '@funds/types';

export function computeAccountState(events: readonly StoredEvent[]): AccountState {
  let ownerName = '';
  let confirmedBalance = 0;
  let pendingDelta = 0;

  // Map from referenceId to captured amount for CAPTURE_RELEASED
  const confirmedCaptures = new Map<string, number>();
  const pendingCaptures = new Map<string, number>();

  const accountId = events[0]?.accountId ?? '';

  for (const event of events) {
    const isConfirmed = event.status === 'synced';

    switch (event.type) {
      case 'ACCOUNT_CREATED':
        ownerName = event.payload.ownerName;
        break;

      case 'DEPOSITED':
        if (isConfirmed) {
          confirmedBalance += event.payload.amount;
        } else {
          pendingDelta += event.payload.amount;
        }
        break;

      case 'WITHDRAWN':
        if (isConfirmed) {
          confirmedBalance -= event.payload.amount;
        } else {
          pendingDelta -= event.payload.amount;
        }
        break;

      case 'CAPTURED':
        if (isConfirmed) {
          confirmedCaptures.set(event.payload.referenceId, event.payload.amount);
          confirmedBalance -= event.payload.amount;
        } else {
          pendingCaptures.set(event.payload.referenceId, event.payload.amount);
          pendingDelta -= event.payload.amount;
        }
        break;

      case 'CAPTURE_RELEASED': {
        const { referenceId } = event.payload;
        if (isConfirmed) {
          const capturedAmount = confirmedCaptures.get(referenceId) ?? pendingCaptures.get(referenceId) ?? 0;
          confirmedBalance += capturedAmount;
          confirmedCaptures.delete(referenceId);
          pendingCaptures.delete(referenceId);
        } else {
          const capturedAmount = confirmedCaptures.get(referenceId) ?? pendingCaptures.get(referenceId) ?? 0;
          pendingDelta += capturedAmount;
          pendingCaptures.delete(referenceId);
        }
        break;
      }

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    accountId,
    ownerName,
    balance: confirmedBalance + pendingDelta,
    pendingBalance: pendingDelta,
  };
}
