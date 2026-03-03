import type { StoredEvent } from './StoredEvent.js';

/** Response from GET /api/accounts/:id/events?afterSeq=<n> */
export interface EventsAfterSeqResponse {
  accountId: string;
  events: StoredEvent[];
}
