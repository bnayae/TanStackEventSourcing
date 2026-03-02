import Dexie, { type Table } from 'dexie';
import type { StoredEvent, EventType } from '@funds/types';

// ─── Database Schema ──────────────────────────────────────────────────────────

export interface DBEvent {
  id: string;           // Primary key (UUID)
  accountId: string;    // Index
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;    // Index (Unix timestamp ms)
  sequenceNumber: number; // Index, scoped per accountId
  status: 'pending' | 'synced' | 'failed';
  syncedAt?: number;
}

// ─── Dexie Database Class ─────────────────────────────────────────────────────

class FundsDatabase extends Dexie {
  events!: Table<DBEvent, string>;

  constructor() {
    super('FundsDatabase');

    this.version(1).stores({
      // Indexes: id (primary key), accountId, createdAt, sequenceNumber, status, [accountId+sequenceNumber]
      events: 'id, accountId, createdAt, sequenceNumber, status, [accountId+sequenceNumber]',
    });
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

export const db = new FundsDatabase();

// ─── Helper to convert DBEvent to StoredEvent ────────────────────────────────

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
