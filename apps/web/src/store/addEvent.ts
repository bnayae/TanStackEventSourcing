import { v4 as uuidv4 } from 'uuid';
import { db, dbEventToStoredEvent, type DBEvent } from '../db/client.js';
import type { StoredEvent, EventType, AccountCreatedPayload, DepositedPayload, WithdrawnPayload, CapturedPayload, CaptureReleasedPayload } from '@funds/types';

type EventPayload =
  | AccountCreatedPayload
  | DepositedPayload
  | WithdrawnPayload
  | CapturedPayload
  | CaptureReleasedPayload;

export async function addEvent(
  accountId: string,
  type: EventType,
  payload: EventPayload
): Promise<StoredEvent> {
  // Get the next sequence number for this account
  const lastEvent = await db.events
    .where('accountId')
    .equals(accountId)
    .sortBy('sequenceNumber')
    .then(events => events[events.length - 1]);

  const sequenceNumber = lastEvent !== undefined ? lastEvent.sequenceNumber + 1 : 0;

  const dbEvent: DBEvent = {
    id: uuidv4(),
    accountId,
    type,
    payload: payload as unknown as Record<string, unknown>,
    createdAt: Date.now(),
    sequenceNumber,
    status: 'pending',
  };

  await db.events.add(dbEvent);
  return dbEventToStoredEvent(dbEvent);
}
