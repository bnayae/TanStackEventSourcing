import { db, dbEventToStoredEvent } from '../db/client.js';
import type { StoredEvent } from '@funds/types';

export async function getAccountEvents(accountId: string): Promise<StoredEvent[]> {
  const dbEvents = await db.events
    .where('accountId')
    .equals(accountId)
    .sortBy('sequenceNumber');

  return dbEvents.map(dbEventToStoredEvent);
}
