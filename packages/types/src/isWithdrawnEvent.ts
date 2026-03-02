import type { FundsEvent } from './FundsEvent.js';
import type { WithdrawnEvent } from './WithdrawnEvent.js';

export function isWithdrawnEvent(event: FundsEvent): event is WithdrawnEvent {
  return event.type === 'WITHDRAWN';
}
