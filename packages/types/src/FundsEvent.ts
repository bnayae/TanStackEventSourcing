import type { AccountCreatedEvent } from './AccountCreatedEvent.js';
import type { DepositedEvent } from './DepositedEvent.js';
import type { WithdrawnEvent } from './WithdrawnEvent.js';
import type { CapturedEvent } from './CapturedEvent.js';
import type { CaptureReleasedEvent } from './CaptureReleasedEvent.js';

export type FundsEvent =
  | AccountCreatedEvent
  | DepositedEvent
  | WithdrawnEvent
  | CapturedEvent
  | CaptureReleasedEvent;
