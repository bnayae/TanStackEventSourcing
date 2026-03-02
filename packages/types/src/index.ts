// ─── Event Types ─────────────────────────────────────────────────────────────

export type EventType =
  | 'ACCOUNT_CREATED'
  | 'DEPOSITED'
  | 'WITHDRAWN'
  | 'CAPTURED'
  | 'CAPTURE_RELEASED';

// ─── Event Payloads ──────────────────────────────────────────────────────────

export interface AccountCreatedPayload {
  ownerName: string;
}

export interface DepositedPayload {
  amount: number;
}

export interface WithdrawnPayload {
  amount: number;
}

export interface CapturedPayload {
  amount: number;
  referenceId: string;
}

export interface CaptureReleasedPayload {
  referenceId: string;
}

// ─── Discriminated Union Events ───────────────────────────────────────────────

export interface BaseEventFields {
  id: string;
  accountId: string;
  createdAt: number; // Unix timestamp ms
  sequenceNumber: number;
}

export interface AccountCreatedEvent extends BaseEventFields {
  type: 'ACCOUNT_CREATED';
  payload: AccountCreatedPayload;
}

export interface DepositedEvent extends BaseEventFields {
  type: 'DEPOSITED';
  payload: DepositedPayload;
}

export interface WithdrawnEvent extends BaseEventFields {
  type: 'WITHDRAWN';
  payload: WithdrawnPayload;
}

export interface CapturedEvent extends BaseEventFields {
  type: 'CAPTURED';
  payload: CapturedPayload;
}

export interface CaptureReleasedEvent extends BaseEventFields {
  type: 'CAPTURE_RELEASED';
  payload: CaptureReleasedPayload;
}

export type FundsEvent =
  | AccountCreatedEvent
  | DepositedEvent
  | WithdrawnEvent
  | CapturedEvent
  | CaptureReleasedEvent;

// ─── Stored Event (with sync status) ─────────────────────────────────────────

export type SyncStatus = 'pending' | 'synced' | 'failed';

export type StoredEvent = FundsEvent & {
  status: SyncStatus;
  syncedAt?: number;
};

// ─── Account State ────────────────────────────────────────────────────────────

export interface AccountState {
  accountId: string;
  ownerName: string;
  balance: number;
  pendingBalance: number;
}

// ─── State computation ────────────────────────────────────────────────────────

export interface ComputeStateResult {
  accountId: string;
  ownerName: string;
  /** Balance from synced events only */
  confirmedBalance: number;
  /** Balance including pending events */
  optimisticBalance: number;
}

// ─── API Request / Response types ─────────────────────────────────────────────

export interface BatchEventItem {
  id: string;
  type: EventType;
  payload: AccountCreatedPayload | DepositedPayload | WithdrawnPayload | CapturedPayload | CaptureReleasedPayload;
  createdAt: number;
  sequenceNumber: number;
}

export interface BatchEventsRequest {
  accountId: string;
  events: BatchEventItem[];
}

export interface BatchEventsResponse {
  accepted: string[];
  rejected: string[];
  serverBalance: number;
}

export interface AccountBalanceResponse {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  updatedAt: string;
}

// ─── Type Guards ──────────────────────────────────────────────────────────────

export function isAccountCreatedEvent(event: FundsEvent): event is AccountCreatedEvent {
  return event.type === 'ACCOUNT_CREATED';
}

export function isDepositedEvent(event: FundsEvent): event is DepositedEvent {
  return event.type === 'DEPOSITED';
}

export function isWithdrawnEvent(event: FundsEvent): event is WithdrawnEvent {
  return event.type === 'WITHDRAWN';
}

export function isCapturedEvent(event: FundsEvent): event is CapturedEvent {
  return event.type === 'CAPTURED';
}

export function isCaptureReleasedEvent(event: FundsEvent): event is CaptureReleasedEvent {
  return event.type === 'CAPTURE_RELEASED';
}

// ─── State Computation (shared logic) ────────────────────────────────────────

/**
 * Replays a sequence of events (ordered by sequenceNumber) to compute account state.
 * This is the canonical state machine shared by both client and server.
 */
export function computeStateFromEvents(
  accountId: string,
  events: readonly FundsEvent[]
): ComputeStateResult & { ownerName: string } {
  let ownerName = '';
  let balance = 0;

  // Map from referenceId to captured amount for CAPTURE_RELEASED
  const captures = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case 'ACCOUNT_CREATED':
        ownerName = event.payload.ownerName;
        break;
      case 'DEPOSITED':
        balance += event.payload.amount;
        break;
      case 'WITHDRAWN':
        balance -= event.payload.amount;
        break;
      case 'CAPTURED':
        captures.set(event.payload.referenceId, event.payload.amount);
        balance -= event.payload.amount;
        break;
      case 'CAPTURE_RELEASED': {
        const capturedAmount = captures.get(event.payload.referenceId) ?? 0;
        balance += capturedAmount;
        captures.delete(event.payload.referenceId);
        break;
      }
      default: {
        // Exhaustive check
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    accountId,
    ownerName,
    confirmedBalance: balance,
    optimisticBalance: balance,
  };
}
