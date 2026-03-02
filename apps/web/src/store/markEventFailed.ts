import { db } from '../db/client.js';

export async function markEventFailed(eventId: string): Promise<void> {
  await db.events.update(eventId, {
    status: 'failed',
  });
}
