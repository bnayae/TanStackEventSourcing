import { createRoute, Link } from '@tanstack/react-router';
import { Route as RootRoute } from './__root.js';
import { useAccountEvents, useAccountState } from '../hooks/useAccountEvents.js';
import { EventList } from '../components/EventList.js';
import { DepositForm } from '../components/DepositForm.js';
import { WithdrawalForm } from '../components/WithdrawalForm.js';
import { CaptureForm } from '../components/CaptureForm.js';
import { ReleaseCaptureForm } from '../components/ReleaseCaptureForm.js';
import { TimeTravelPanel } from '../components/TimeTravelPanel.js';

function AccountDetailPage() {
  const { id } = Route.useParams();
  const events = useAccountEvents(id);
  const state = useAccountState(id);

  if (events === undefined || state === undefined) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-gray-500">Loading account...</div>
      </div>
    );
  }

  const pendingCount = events.filter(e => e.status === 'pending').length;
  const failedCount = events.filter(e => e.status === 'failed').length;

  return (
    <div>
      {/* Account Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <Link to="/" className="hover:text-gray-700">Accounts</Link>
          <span>/</span>
          <span className="text-gray-900 font-medium">{state.ownerName}</span>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{state.ownerName}</h1>
          <Link
            to="/accounts/$id/balance"
            params={{ id }}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            View Server Balance
          </Link>
        </div>
        <p className="text-xs text-gray-400 font-mono mt-1">{id}</p>
      </div>

      {/* Balance Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Optimistic Balance</div>
          <div className="text-2xl font-bold text-gray-900">
            ${state.balance.toFixed(2)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Pending Delta</div>
          <div className={`text-2xl font-bold ${state.pendingBalance !== 0 ? 'text-amber-600' : 'text-gray-400'}`}>
            {state.pendingBalance >= 0 ? '+' : ''}${state.pendingBalance.toFixed(2)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Events</div>
          <div className="text-2xl font-bold text-gray-900">{events.length}</div>
          {pendingCount > 0 && (
            <div className="text-xs text-amber-600 mt-0.5">{pendingCount} pending</div>
          )}
          {failedCount > 0 && (
            <div className="text-xs text-red-600 mt-0.5">{failedCount} failed</div>
          )}
        </div>
      </div>

      {/* Transaction Forms */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <DepositForm accountId={id} events={events} />
        <WithdrawalForm accountId={id} events={events} />
        <CaptureForm accountId={id} events={events} />
        <ReleaseCaptureForm accountId={id} events={events} />
      </div>

      {/* Time Travel */}
      <div className="mb-6">
        <TimeTravelPanel accountId={id} currentBalance={state.balance} events={events} />
      </div>

      {/* Event History */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Event History</h2>
        <EventList events={events} />
      </div>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/accounts/$id',
  component: AccountDetailPage,
});
