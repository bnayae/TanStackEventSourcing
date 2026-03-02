import { useEffect } from 'react';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import { usePendingEventCount } from '../hooks/useAccounts.js';
import { syncEngine } from '../sync/syncEngine.js';

export function NetworkStatusBanner() {
  const { status, isManuallyOffline, toggleManualOffline } = useNetworkStatus();
  const pendingCount = usePendingEventCount();

  // Keep sync engine in sync with manual override
  useEffect(() => {
    syncEngine.setManuallyOffline(isManuallyOffline);
  }, [isManuallyOffline]);

  const toggleButton = (
    <button
      onClick={toggleManualOffline}
      className={`ml-3 px-2 py-0.5 text-xs rounded border transition-colors ${
        isManuallyOffline
          ? 'border-blue-400 text-blue-300 hover:bg-blue-900'
          : 'border-gray-500 text-gray-300 hover:bg-gray-700'
      }`}
    >
      {isManuallyOffline ? 'Go Online' : 'Simulate Offline'}
    </button>
  );

  if (status === 'online' && pendingCount === 0) {
    return (
      <div className="bg-gray-100 border-b border-gray-200 text-gray-500 text-center text-xs py-1 px-4 flex items-center justify-end">
        {toggleButton}
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div className="bg-gray-800 text-white text-center text-sm py-2 px-4 flex items-center justify-center">
        <span className="inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-gray-400" />
          {isManuallyOffline ? 'Simulating offline mode.' : 'You are offline.'}{' '}
          Changes will sync when you reconnect.
          {pendingCount > 0 && (
            <span className="ml-1 font-medium">
              ({pendingCount} event{pendingCount !== 1 ? 's' : ''} pending)
            </span>
          )}
        </span>
        {toggleButton}
      </div>
    );
  }

  // Online but has pending events (syncing)
  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-center text-sm py-2 px-4 flex items-center justify-center">
      <span className="inline-flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        Syncing {pendingCount} pending event{pendingCount !== 1 ? 's' : ''}...
      </span>
      {toggleButton}
    </div>
  );
}
