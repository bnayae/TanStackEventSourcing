import { useState } from 'react';
import type { StoredEvent } from '@funds/types';
import { addEvent, computeAccountState, validateWithdrawal } from '../store/eventStore.js';
import { syncEngine } from '../sync/syncEngine.js';

interface WithdrawalFormProps {
  accountId: string;
  events: StoredEvent[];
}

export function WithdrawalForm({ accountId, events }: WithdrawalFormProps) {
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const state = computeAccountState(events);
  const hasBalance = state.balance > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Please enter a valid positive amount');
      return;
    }

    const validation = validateWithdrawal(events, parsedAmount);
    if (!validation.valid) {
      setError(validation.error ?? 'Invalid withdrawal');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await addEvent(accountId, 'WITHDRAWN', { amount: parsedAmount });
      syncEngine.triggerSync();
      setAmount('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add withdrawal');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs">−</span>
        Withdraw
      </h3>
      {!hasBalance && (
        <p className="text-xs text-gray-400 mb-2">No balance available to withdraw</p>
      )}
      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
            <input
              type="number"
              value={amount}
              onChange={e => { setAmount(e.target.value); setError(null); }}
              placeholder="0.00"
              min="0.01"
              step="0.01"
              max={state.balance}
              className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:bg-gray-50"
              disabled={isSubmitting || !hasBalance}
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSubmitting || amount.trim() === '' || !hasBalance}
          >
            {isSubmitting ? '...' : 'Withdraw'}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Available: ${state.balance.toFixed(2)}
        </p>
        {error !== null && (
          <p className="mt-2 text-xs text-red-600">{error}</p>
        )}
        {success && (
          <p className="mt-2 text-xs text-green-600">Withdrawal recorded!</p>
        )}
      </form>
    </div>
  );
}
