import type { BaseEventFields } from './BaseEventFields.js';
import type { DepositedPayload } from './DepositedPayload.js';

export interface DepositedEvent extends BaseEventFields {
  type: 'DEPOSITED';
  payload: DepositedPayload;
}
