import type { StoredEvent } from '@funds/types';
import { computeAccountState } from './computeAccountState.js';
import type { ValidationResult } from './ValidationResult.js';

export function validateCapture(
  events: readonly StoredEvent[],
  amount: number
): ValidationResult {
  const state = computeAccountState(events);
  if (amount > state.balance) {
    return {
      valid: false,
      error: `Insufficient balance for capture: have ${state.balance.toFixed(2)}, need ${amount.toFixed(2)}`,
    };
  }
  return { valid: true };
}
