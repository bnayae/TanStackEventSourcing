import { createRoute, Link } from '@tanstack/react-router';
import { Route as RootRoute } from './__root.js';
import { useAccountState } from '../hooks/useAccountEvents.js';
import { ServerBalance } from '../components/ServerBalance.js';

function ServerBalancePage() {
  const { id } = Route.useParams();
  const localState = useAccountState(id);

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <Link to="/" className="hover:text-gray-700">Accounts</Link>
          <span>/</span>
          <Link to="/accounts/$id" params={{ id }} className="hover:text-gray-700">
            {localState?.ownerName ?? id}
          </Link>
          <span>/</span>
          <span className="text-gray-900 font-medium">Server Balance</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Server Balance</h1>
        <p className="text-sm text-gray-500 mt-1">Authoritative balance from the server</p>
      </div>

      <ServerBalance accountId={id} localState={localState} />

      <div className="mt-4">
        <Link
          to="/accounts/$id"
          params={{ id }}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          &larr; Back to Account
        </Link>
      </div>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/accounts/$id/balance',
  component: ServerBalancePage,
});
