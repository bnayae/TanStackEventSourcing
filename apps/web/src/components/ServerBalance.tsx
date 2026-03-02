import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AccountState } from '@funds/types';
import { syncEngine } from '../sync/syncEngine.js';

interface AccountBalanceResponse {
  accountId: string;
  ownerName: string;
  balance: number;
  lastSeq: number;
  updatedAt: string;
}

interface ServerEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sequenceNumber: number;
  createdAt: number;
}

interface ServerEventsResponse {
  accountId: string;
  events: ServerEvent[];
}

interface ServerBalanceProps {
  accountId: string;
  localState: AccountState | undefined;
}

async function fetchAccountBalance(accountId: string): Promise<AccountBalanceResponse> {
  const response = await fetch(`/api/accounts/${accountId}/balance`);

  if (response.status === 404) {
    throw new Error('Account not found on server. It may not have synced yet.');
  }

  if (!response.ok) {
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<AccountBalanceResponse>;
}

async function fetchAccountEvents(accountId: string): Promise<ServerEventsResponse> {
  const response = await fetch(`/api/accounts/${accountId}/events`);

  if (!response.ok) {
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<ServerEventsResponse>;
}

function formatEventPayload(event: ServerEvent): string {
  switch (event.type) {
    case 'DEPOSITED':
    case 'WITHDRAWN':
      return `$${Number(event.payload['amount'] ?? 0).toFixed(2)}`;
    case 'CAPTURED':
      return `$${Number(event.payload['amount'] ?? 0).toFixed(2)} ref:${String(event.payload['referenceId'] ?? '')}`;
    case 'CAPTURE_RELEASED':
      return `ref:${String(event.payload['referenceId'] ?? '')}`;
    case 'ACCOUNT_CREATED':
      return String(event.payload['ownerName'] ?? '');
    default:
      return JSON.stringify(event.payload);
  }
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  DEPOSITED: 'bg-green-100 text-green-800',
  WITHDRAWN: 'bg-red-100 text-red-800',
  CAPTURED: 'bg-orange-100 text-orange-800',
  CAPTURE_RELEASED: 'bg-blue-100 text-blue-800',
  ACCOUNT_CREATED: 'bg-gray-100 text-gray-700',
};

export function ServerBalance({ accountId, localState }: ServerBalanceProps) {
  const queryClient = useQueryClient();

  const {
    data: serverBalance,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['serverBalance', accountId],
    queryFn: () => fetchAccountBalance(accountId),
    retry: 1,
    staleTime: 0,
  });

  const {
    data: serverEvents,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['serverEvents', accountId],
    queryFn: () => fetchAccountEvents(accountId),
    retry: 1,
    staleTime: 0,
  });

  useEffect(() => {
    return syncEngine.onSyncComplete((syncedAccountIds) => {
      if (syncedAccountIds.includes(accountId)) {
        void queryClient.invalidateQueries({ queryKey: ['serverBalance', accountId] });
        void queryClient.invalidateQueries({ queryKey: ['serverEvents', accountId] });
      }
    });
  }, [accountId, queryClient]);

  const discrepancy =
    serverBalance !== undefined && localState !== undefined
      ? localState.balance - serverBalance.balance
      : null;

  const handleRefresh = () => {
    void refetch();
    void refetchEvents();
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">Server (Authoritative) Balance</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Fetched from <code className="font-mono">GET /api/accounts/{accountId}/balance</code>
        </p>
      </div>

      <div className="p-5">
        {isLoading && (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            Fetching server balance...
          </div>
        )}

        {isError && (
          <div className="space-y-3">
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error instanceof Error ? error.message : 'Failed to fetch server balance'}
            </div>
            <button
              onClick={() => void refetch()}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {serverBalance !== undefined && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-gray-500 mb-1">Server Balance</div>
                <div className="text-2xl font-bold text-gray-900">
                  ${serverBalance.balance.toFixed(2)}
                </div>
              </div>
              {localState !== undefined && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">Local (Optimistic)</div>
                  <div className="text-2xl font-bold text-gray-900">
                    ${localState.balance.toFixed(2)}
                  </div>
                </div>
              )}
            </div>

            {discrepancy !== null && Math.abs(discrepancy) > 0.001 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                <strong>Discrepancy:</strong>{' '}
                Local balance is {discrepancy > 0 ? '+' : ''}${discrepancy.toFixed(2)} compared to server.
                This is likely due to pending unsynced events.
              </div>
            )}

            {discrepancy !== null && Math.abs(discrepancy) <= 0.001 && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                Local and server balances match.
              </div>
            )}

            <div className="text-xs text-gray-400 space-y-1">
              <div>
                <span className="font-medium">Owner:</span> {serverBalance.ownerName}
              </div>
              <div>
                <span className="font-medium">Last sequence:</span> {serverBalance.lastSeq}
              </div>
              <div>
                <span className="font-medium">Updated:</span>{' '}
                {new Date(serverBalance.updatedAt).toLocaleString()}
              </div>
            </div>

            <button
              onClick={handleRefresh}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-gray-700"
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {/* Last 10 Server Events */}
      {serverEvents !== undefined && serverEvents.events.length > 0 && (
        <div className="border-t border-gray-100">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
              Last {serverEvents.events.length} Server Events
            </h3>
          </div>
          <ul className="divide-y divide-gray-50">
            {serverEvents.events.map(event => (
              <li key={event.id} className="px-5 py-3 flex items-start gap-3">
                <span className="text-xs text-gray-400 font-mono mt-0.5 w-6 text-right shrink-0">
                  #{event.sequenceNumber}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium ${EVENT_TYPE_STYLES[event.type] ?? 'bg-gray-100 text-gray-700'}`}
                    >
                      {event.type}
                    </span>
                    <span className="text-sm text-gray-700">{formatEventPayload(event)}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {new Date(event.createdAt).toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {serverEvents !== undefined && serverEvents.events.length === 0 && (
        <div className="border-t border-gray-100 px-5 py-4 text-xs text-gray-400">
          No server events yet.
        </div>
      )}
    </div>
  );
}
