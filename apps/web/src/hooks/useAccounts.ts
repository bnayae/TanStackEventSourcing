import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/client.js';
import { computeAccountState, type AccountSummary } from '../store/eventStore.js';
import { dbEventToStoredEvent } from '../db/client.js';

export function useAccounts(): AccountSummary[] | undefined {
  return useLiveQuery(async () => {
    const allEvents = await db.events.orderBy('sequenceNumber').toArray();

    // Group events by accountId
    const byAccount = new Map<string, typeof allEvents>();
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
  }, []);
}

export function usePendingEventCount(): number {
  const count = useLiveQuery(async () => {
    return db.events.where('status').equals('pending').count();
  }, []);

  return count ?? 0;
}
