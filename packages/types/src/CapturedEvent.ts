import type { BaseEventFields } from './BaseEventFields.js';
import type { CapturedPayload } from './CapturedPayload.js';

export interface CapturedEvent extends BaseEventFields {
  type: 'CAPTURED';
  payload: CapturedPayload;
}
