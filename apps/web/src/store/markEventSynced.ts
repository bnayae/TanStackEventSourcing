import { db } from '../db/client.js';

export async function markEventSynced(eventId: string): Promise<void> {
  await db.events.update(eventId, {
    status: 'synced',
    syncedAt: Date.now(),
  });
}
