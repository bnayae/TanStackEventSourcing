import { useLiveQuery } from 'dexie-react-hooks';
import { db, dbEventToStoredEvent } from '../db/client.js';
import { computeAccountState } from '../store/eventStore.js';
import type { StoredEvent } from '@funds/types';
import type { AccountState } from '@funds/types';

export function useAccountEvents(accountId: string): StoredEvent[] | undefined {
  return useLiveQuery(async () => {
    const dbEvents = await db.events
      .where('accountId')
      .equals(accountId)
      .sortBy('sequenceNumber');

    return dbEvents.map(dbEventToStoredEvent);
  }, [accountId]);
}

export function useAccountState(accountId: string): AccountState | undefined {
  return useLiveQuery(async () => {
    const dbEvents = await db.events
      .where('accountId')
      .equals(accountId)
      .sortBy('sequenceNumber');

    if (dbEvents.length === 0) return undefined;

    const storedEvents = dbEvents.map(dbEventToStoredEvent);
    return computeAccountState(storedEvents);
  }, [accountId]);
}
