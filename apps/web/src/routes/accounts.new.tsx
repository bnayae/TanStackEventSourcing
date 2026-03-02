import { createRoute, useNavigate } from '@tanstack/react-router';
import { Route as RootRoute } from './__root.js';
import { useState } from 'react';
import { addEvent } from '../store/eventStore.js';
import { syncEngine } from '../sync/syncEngine.js';

function NewAccountPage() {
  const navigate = useNavigate();
  const [ownerName, setOwnerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = ownerName.trim();
    if (!trimmedName) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Generate a new account ID
      const accountId = crypto.randomUUID();

      // Add the ACCOUNT_CREATED event
      await addEvent(accountId, 'ACCOUNT_CREATED', { ownerName: trimmedName });

      // Trigger sync
      syncEngine.triggerSync();

      // Navigate to the new account
      await navigate({ to: '/accounts/$id', params: { id: accountId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">New Account</h1>
        <p className="text-gray-500 mt-1">Create a new funds account</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div className="mb-4">
            <label htmlFor="ownerName" className="block text-sm font-medium text-gray-700 mb-1">
              Account Owner Name
            </label>
            <input
              id="ownerName"
              type="text"
              value={ownerName}
              onChange={e => setOwnerName(e.target.value)}
              placeholder="e.g. Alice Johnson"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          {error !== null && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void navigate({ to: '/' })}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting || ownerName.trim().length === 0}
            >
              {isSubmitting ? 'Creating...' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/accounts/new',
  component: NewAccountPage,
});
