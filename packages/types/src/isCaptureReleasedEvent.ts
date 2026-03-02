import type { FundsEvent } from './FundsEvent.js';
import type { CaptureReleasedEvent } from './CaptureReleasedEvent.js';

export function isCaptureReleasedEvent(event: FundsEvent): event is CaptureReleasedEvent {
  return event.type === 'CAPTURE_RELEASED';
}
