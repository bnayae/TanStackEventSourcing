import { createRoute } from '@tanstack/react-router';
import { Route as RootRoute } from './__root.js';
import { useAccounts } from '../hooks/useAccounts.js';
import { AccountCard } from '../components/AccountCard.js';
import { Link } from '@tanstack/react-router';

function AccountListPage() {
  const accounts = useAccounts();

  if (accounts === undefined) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-gray-500">Loading accounts...</div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-6xl mb-4">🏦</div>
        <h2 className="text-2xl font-bold text-gray-700 mb-2">No Accounts Yet</h2>
        <p className="text-gray-500 mb-6">Create your first account to get started.</p>
        <Link
          to="/accounts/new"
          className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          Create Account
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
        <span className="text-sm text-gray-500">{accounts.length} account{accounts.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="grid gap-4">
        {accounts.map(account => (
          <AccountCard key={account.accountId} account={account} />
        ))}
      </div>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: AccountListPage,
});
