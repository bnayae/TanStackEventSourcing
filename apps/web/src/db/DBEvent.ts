import type { EventType } from '@funds/types';

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
