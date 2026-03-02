import type { BaseEventFields } from './BaseEventFields.js';
import type { AccountCreatedPayload } from './AccountCreatedPayload.js';

export interface AccountCreatedEvent extends BaseEventFields {
  type: 'ACCOUNT_CREATED';
  payload: AccountCreatedPayload;
}
