import { db, dbEventToStoredEvent, type DBEvent } from '../db/client.js';
import { computeAccountState } from './computeAccountState.js';
import type { AccountSummary } from './AccountSummary.js';

export async function getAccounts(): Promise<AccountSummary[]> {
  const allEvents = await db.events.orderBy('sequenceNumber').toArray();

  // Group events by accountId
  const byAccount = new Map<string, DBEvent[]>();
  for (const event of allEvents) {
    const existing = byAccount.get(event.accountId) ?? [];
    existing.push(event);
    byAccount.set(event.accountId, existing);
  }

  const accounts: AccountSummary[] = [];

  for (const [accountId, dbEvents] of byAccount) {
    const storedEvents = dbEvents.map(dbEventToStoredEvent);
    const state = computeAccountState(storedEvents);
    const pendingEventCount = storedEvents.filter(e => e.status === 'pending').length;

    accounts.push({
      accountId,
      ownerName: state.ownerName,
      balance: state.balance,
      pendingBalance: state.pendingBalance,
      pendingEventCount,
      totalEventCount: storedEvents.length,
    });
  }

  return accounts;
}
