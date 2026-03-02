import type { StoredEvent } from '@funds/types';
import type { DBEvent } from './DBEvent.js';

export function dbEventToStoredEvent(dbEvent: DBEvent): StoredEvent {
  const base = {
    id: dbEvent.id,
    accountId: dbEvent.accountId,
    createdAt: dbEvent.createdAt,
    sequenceNumber: dbEvent.sequenceNumber,
    status: dbEvent.status,
    ...(dbEvent.syncedAt !== undefined ? { syncedAt: dbEvent.syncedAt } : {}),
  };

  switch (dbEvent.type) {
    case 'ACCOUNT_CREATED':
      return {
        ...base,
        type: 'ACCOUNT_CREATED',
        payload: { ownerName: String(dbEvent.payload['ownerName'] ?? '') },
      };
    case 'DEPOSITED':
      return {
        ...base,
        type: 'DEPOSITED',
        payload: { amount: Number(dbEvent.payload['amount'] ?? 0) },
      };
    case 'WITHDRAWN':
      return {
        ...base,
        type: 'WITHDRAWN',
        payload: { amount: Number(dbEvent.payload['amount'] ?? 0) },
      };
    case 'CAPTURED':
      return {
        ...base,
        type: 'CAPTURED',
        payload: {
          amount: Number(dbEvent.payload['amount'] ?? 0),
          referenceId: String(dbEvent.payload['referenceId'] ?? ''),
        },
      };
    case 'CAPTURE_RELEASED':
      return {
        ...base,
        type: 'CAPTURE_RELEASED',
        payload: { referenceId: String(dbEvent.payload['referenceId'] ?? '') },
      };
    default: {
      const _exhaustive: never = dbEvent.type;
      throw new Error(`Unknown event type: ${String(_exhaustive)}`);
    }
  }
}
