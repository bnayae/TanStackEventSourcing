import type { FundsEvent } from './FundsEvent.js';
import type { AccountCreatedEvent } from './AccountCreatedEvent.js';

export function isAccountCreatedEvent(event: FundsEvent): event is AccountCreatedEvent {
  return event.type === 'ACCOUNT_CREATED';
}
