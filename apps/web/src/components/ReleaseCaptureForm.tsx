import { useState } from 'react';
import type { StoredEvent } from '@funds/types';
import { addEvent, getActiveCaptureReferenceIds } from '../store/eventStore.js';
import { syncEngine } from '../sync/syncEngine.js';

interface ReleaseCaptureFormProps {
  accountId: string;
  events: StoredEvent[];
}

export function ReleaseCaptureForm({ accountId, events }: ReleaseCaptureFormProps) {
  const [selectedRefId, setSelectedRefId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const activeCaptures = getActiveCaptureReferenceIds(events);
  const hasCaptures = activeCaptures.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedRefId) {
      setError('Please select a capture to release');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await addEvent(accountId, 'CAPTURE_RELEASED', { referenceId: selectedRefId });
      syncEngine.triggerSync();
      setSelectedRefId('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release capture');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs">R</span>
        Release Capture
      </h3>
      {!hasCaptures && (
        <p className="text-xs text-gray-400 mb-2">No active captures to release</p>
      )}
      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <div className="flex gap-2">
          <select
            value={selectedRefId}
            onChange={e => { setSelectedRefId(e.target.value); setError(null); }}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-gray-50 bg-white"
            disabled={isSubmitting || !hasCaptures}
          >
            <option value="">Select capture...</option>
            {activeCaptures.map(refId => (
              <option key={refId} value={refId}>
                {refId}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSubmitting || !selectedRefId || !hasCaptures}
          >
            {isSubmitting ? '...' : 'Release'}
          </button>
        </div>
        {error !== null && (
          <p className="mt-2 text-xs text-red-600">{error}</p>
        )}
        {success && (
          <p className="mt-2 text-xs text-green-600">Capture released!</p>
        )}
      </form>
    </div>
  );
}
