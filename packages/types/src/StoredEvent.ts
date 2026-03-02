import type { FundsEvent } from './FundsEvent.js';
import type { SyncStatus } from './SyncStatus.js';

export type StoredEvent = FundsEvent & {
  status: SyncStatus;
  syncedAt?: number;
};
