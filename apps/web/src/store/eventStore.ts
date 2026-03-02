import { v4 as uuidv4 } from 'uuid';
import { db, dbEventToStoredEvent, type DBEvent } from '../db/client.js';
import type {
  StoredEvent,
  AccountState,
  FundsEvent,
  EventType,
  AccountCreatedPayload,
  DepositedPayload,
  WithdrawnPayload,
  CapturedPayload,
  CaptureReleasedPayload,
} from '@funds/types';

type EventPayload =
  | AccountCreatedPayload
  | DepositedPayload
  | WithdrawnPayload
  | CapturedPayload
  | CaptureReleasedPayload;

// ─── Add Event ────────────────────────────────────────────────────────────────

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
    payload: payload as Record<string, unknown>,
    createdAt: Date.now(),
    sequenceNumber,
    status: 'pending',
  };

  await db.events.add(dbEvent);
  return dbEventToStoredEvent(dbEvent);
}

// ─── Get Account Events ───────────────────────────────────────────────────────

export async function getAccountEvents(accountId: string): Promise<StoredEvent[]> {
  const dbEvents = await db.events
    .where('accountId')
    .equals(accountId)
    .sortBy('sequenceNumber');

  return dbEvents.map(dbEventToStoredEvent);
}

// ─── Get Pending Events ───────────────────────────────────────────────────────

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

// ─── Mark Event Synced ────────────────────────────────────────────────────────

export async function markEventSynced(eventId: string): Promise<void> {
  await db.events.update(eventId, {
    status: 'synced',
    syncedAt: Date.now(),
  });
}

// ─── Mark Event Failed ────────────────────────────────────────────────────────

export async function markEventFailed(eventId: string): Promise<void> {
  await db.events.update(eventId, {
    status: 'failed',
  });
}

// ─── Compute Account State ────────────────────────────────────────────────────

export function computeAccountState(events: readonly StoredEvent[]): AccountState {
  let ownerName = '';
  let confirmedBalance = 0;
  let pendingDelta = 0;

  // Map from referenceId to captured amount for CAPTURE_RELEASED
  const confirmedCaptures = new Map<string, number>();
  const pendingCaptures = new Map<string, number>();

  const accountId = events[0]?.accountId ?? '';

  for (const event of events) {
    const isConfirmed = event.status === 'synced';

    switch (event.type) {
      case 'ACCOUNT_CREATED':
        ownerName = event.payload.ownerName;
        break;

      case 'DEPOSITED':
        if (isConfirmed) {
          confirmedBalance += event.payload.amount;
        } else {
          pendingDelta += event.payload.amount;
        }
        break;

      case 'WITHDRAWN':
        if (isConfirmed) {
          confirmedBalance -= event.payload.amount;
        } else {
          pendingDelta -= event.payload.amount;
        }
        break;

      case 'CAPTURED':
        if (isConfirmed) {
          confirmedCaptures.set(event.payload.referenceId, event.payload.amount);
          confirmedBalance -= event.payload.amount;
        } else {
          pendingCaptures.set(event.payload.referenceId, event.payload.amount);
          pendingDelta -= event.payload.amount;
        }
        break;

      case 'CAPTURE_RELEASED': {
        const { referenceId } = event.payload;
        if (isConfirmed) {
          const capturedAmount = confirmedCaptures.get(referenceId) ?? pendingCaptures.get(referenceId) ?? 0;
          confirmedBalance += capturedAmount;
          confirmedCaptures.delete(referenceId);
          pendingCaptures.delete(referenceId);
        } else {
          const capturedAmount = confirmedCaptures.get(referenceId) ?? pendingCaptures.get(referenceId) ?? 0;
          pendingDelta += capturedAmount;
          pendingCaptures.delete(referenceId);
        }
        break;
      }

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    accountId,
    ownerName,
    balance: confirmedBalance + pendingDelta,
    pendingBalance: pendingDelta,
  };
}

// ─── Get All Accounts (derived from events) ───────────────────────────────────

export interface AccountSummary {
  accountId: string;
  ownerName: string;
  balance: number;
  pendingBalance: number;
  pendingEventCount: number;
  totalEventCount: number;
}

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

// ─── Validate Event (before adding) ──────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateWithdrawal(
  events: readonly StoredEvent[],
  amount: number
): ValidationResult {
  const state = computeAccountState(events);
  if (amount > state.balance) {
    return {
      valid: false,
      error: `Insufficient balance: have ${state.balance.toFixed(2)}, need ${amount.toFixed(2)}`,
    };
  }
  return { valid: true };
}

export function validateCapture(
  events: readonly StoredEvent[],
  amount: number
): ValidationResult {
  const state = computeAccountState(events);
  if (amount > state.balance) {
    return {
      valid: false,
      error: `Insufficient balance for capture: have ${state.balance.toFixed(2)}, need ${amount.toFixed(2)}`,
    };
  }
  return { valid: true };
}

// ─── Get captured events (for release form) ───────────────────────────────────

export function getActiveCaptureReferenceIds(events: readonly StoredEvent[]): string[] {
  const captured = new Set<string>();
  const released = new Set<string>();

  for (const event of events) {
    if (event.type === 'CAPTURED') {
      captured.add(event.payload.referenceId);
    } else if (event.type === 'CAPTURE_RELEASED') {
      released.add(event.payload.referenceId);
    }
  }

  return Array.from(captured).filter(id => !released.has(id));
}

// ─── Delete Account (local) ───────────────────────────────────────────────────

export async function deleteAccount(accountId: string): Promise<void> {
  await db.events.where('accountId').equals(accountId).delete();
}

// Re-export FundsEvent for convenience
export type { FundsEvent, StoredEvent };
