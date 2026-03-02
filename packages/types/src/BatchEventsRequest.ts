import type { BatchEventItem } from './BatchEventItem.js';

export interface BatchEventsRequest {
  accountId: string;
  events: BatchEventItem[];
}
