import type { FundsEvent } from './FundsEvent.js';
import type { CapturedEvent } from './CapturedEvent.js';

export function isCapturedEvent(event: FundsEvent): event is CapturedEvent {
  return event.type === 'CAPTURED';
}
