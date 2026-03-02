import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AccountSummary } from '../store/eventStore.js';
import { deleteAccount } from '../store/eventStore.js';

interface AccountCardProps {
  account: AccountSummary;
}

export function AccountCard({ account }: AccountCardProps) {
  const hasPending = account.pendingEventCount > 0;
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const navigate = useNavigate();

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(true);
  };

  const handleConfirmDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDeleting(true);
    // Best-effort server delete
    void fetch(`/api/accounts/${account.accountId}`, { method: 'DELETE' });
    await deleteAccount(account.accountId);
    void navigate({ to: '/' });
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <div className="flex items-stretch bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-200 transition-all">
      {/* Clickable area */}
      <Link
        to="/accounts/$id"
        params={{ id: account.accountId }}
        className="flex-1 min-w-0 p-5"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold text-gray-900 truncate">
                {account.ownerName}
              </h2>
              {hasPending && (
                <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                  {account.pendingEventCount} pending
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 font-mono truncate">{account.accountId}</p>
          </div>

          <div className="ml-4 text-right shrink-0">
            <div className="text-xl font-bold text-gray-900">
              ${account.balance.toFixed(2)}
            </div>
            {hasPending && account.pendingBalance !== 0 && (
              <div className="text-xs text-amber-600 mt-0.5">
                {account.pendingBalance >= 0 ? '+' : ''}${account.pendingBalance.toFixed(2)} pending
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
          <span>{account.totalEventCount} event{account.totalEventCount !== 1 ? 's' : ''}</span>
          <span className="text-blue-500">View details &rarr;</span>
        </div>
      </Link>

      {/* Delete button — separate column, never overlaps content */}
      <div className="flex items-center px-3 border-l border-gray-100 shrink-0">
        {!confirming ? (
          <button
            onClick={handleDeleteClick}
            className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title="Delete account"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-red-700 font-medium">Delete?</span>
            <div className="flex gap-1">
              <button
                onClick={(e) => { void handleConfirmDelete(e); }}
                disabled={isDeleting}
                className="text-xs text-white bg-red-600 hover:bg-red-700 rounded px-2 py-0.5 disabled:opacity-50 transition-colors"
              >
                {isDeleting ? '...' : 'Yes'}
              </button>
              <button
                onClick={handleCancelDelete}
                className="text-xs text-gray-600 hover:text-gray-800 rounded px-1 py-0.5 transition-colors"
              >
                No
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
