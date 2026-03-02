import { db } from '../db/client.js';

export async function deleteAccount(accountId: string): Promise<void> {
  await db.events.where('accountId').equals(accountId).delete();
}
