import type { EventType } from './EventType.js';
import type { AccountCreatedPayload } from './AccountCreatedPayload.js';
import type { DepositedPayload } from './DepositedPayload.js';
import type { WithdrawnPayload } from './WithdrawnPayload.js';
import type { CapturedPayload } from './CapturedPayload.js';
import type { CaptureReleasedPayload } from './CaptureReleasedPayload.js';

export interface BatchEventItem {
  id: string;
  type: EventType;
  payload: AccountCreatedPayload | DepositedPayload | WithdrawnPayload | CapturedPayload | CaptureReleasedPayload;
  createdAt: number;
  sequenceNumber: number;
}
