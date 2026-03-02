import { db, dbEventToStoredEvent } from '../db/client.js';
import type { StoredEvent } from '@funds/types';

export async function getPendingEvents(): Promise<StoredEvent[]> {
  const dbEvents = await db.events
    .where('status')
    .equals('pending')
    .toArray();

  // Sort by accountId then sequenceNumber
  dbEvents.sort((a, b) => {
    if (a.accountId !== b.accountId) {
      return a.accountId.localeCompare(b.accountId);
    }
    return a.sequenceNumber - b.sequenceNumber;
  });

  return dbEvents.map(dbEventToStoredEvent);
}
