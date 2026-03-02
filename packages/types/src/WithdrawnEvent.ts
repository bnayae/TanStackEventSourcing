import type { BaseEventFields } from './BaseEventFields.js';
import type { WithdrawnPayload } from './WithdrawnPayload.js';

export interface WithdrawnEvent extends BaseEventFields {
  type: 'WITHDRAWN';
  payload: WithdrawnPayload;
}
