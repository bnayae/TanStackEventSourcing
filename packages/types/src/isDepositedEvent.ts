import type { FundsEvent } from './FundsEvent.js';
import type { DepositedEvent } from './DepositedEvent.js';

export function isDepositedEvent(event: FundsEvent): event is DepositedEvent {
  return event.type === 'DEPOSITED';
}
