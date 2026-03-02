import type { BaseEventFields } from './BaseEventFields.js';
import type { CaptureReleasedPayload } from './CaptureReleasedPayload.js';

export interface CaptureReleasedEvent extends BaseEventFields {
  type: 'CAPTURE_RELEASED';
  payload: CaptureReleasedPayload;
}
