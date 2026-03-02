import { createRootRouteWithContext, Outlet, Link } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { NetworkStatusBanner } from '../components/NetworkStatusBanner.js';
import { usePendingEventCount } from '../hooks/useAccounts.js';

interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  const pendingCount = usePendingEventCount();

  return (
    <div className="min-h-screen bg-gray-50">
      <NetworkStatusBanner />

      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-xl font-bold text-blue-600 hover:text-blue-700">
            <span>Funds Manager</span>
          </Link>
          <div className="flex items-center gap-4">
            {pendingCount > 0 && (
              <span className="text-sm text-amber-600 font-medium">
                {pendingCount} event{pendingCount !== 1 ? 's' : ''} pending sync
              </span>
            )}
            <Link
              to="/accounts/new"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              New Account
            </Link>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
