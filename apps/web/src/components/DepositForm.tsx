import { useState } from 'react';
import type { StoredEvent } from '@funds/types';
import { addEvent } from '../store/eventStore.js';
import { syncEngine } from '../sync/syncEngine.js';

interface DepositFormProps {
  accountId: string;
  events: StoredEvent[];
}

export function DepositForm({ accountId }: DepositFormProps) {
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Please enter a valid positive amount');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await addEvent(accountId, 'DEPOSITED', { amount: parsedAmount });
      syncEngine.triggerSync();
      setAmount('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add deposit');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs">+</span>
        Deposit
      </h3>
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
              className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              disabled={isSubmitting}
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSubmitting || amount.trim() === ''}
          >
            {isSubmitting ? '...' : 'Deposit'}
          </button>
        </div>
        {error !== null && (
          <p className="mt-2 text-xs text-red-600">{error}</p>
        )}
        {success && (
          <p className="mt-2 text-xs text-green-600">Deposit recorded!</p>
        )}
      </form>
    </div>
  );
}
