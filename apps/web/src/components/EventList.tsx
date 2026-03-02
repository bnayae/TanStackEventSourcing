import type { StoredEvent } from '@funds/types';

interface EventListProps {
  events: StoredEvent[];
}

function formatEventType(type: StoredEvent['type']): string {
  switch (type) {
    case 'ACCOUNT_CREATED': return 'Account Created';
    case 'DEPOSITED': return 'Deposit';
    case 'WITHDRAWN': return 'Withdrawal';
    case 'CAPTURED': return 'Capture';
    case 'CAPTURE_RELEASED': return 'Capture Released';
    default: {
      const _exhaustive: never = type;
      return String(_exhaustive);
    }
  }
}

function formatPayload(event: StoredEvent): string {
  switch (event.type) {
    case 'ACCOUNT_CREATED':
      return `Owner: ${event.payload.ownerName}`;
    case 'DEPOSITED':
      return `+$${event.payload.amount.toFixed(2)}`;
    case 'WITHDRAWN':
      return `-$${event.payload.amount.toFixed(2)}`;
    case 'CAPTURED':
      return `-$${event.payload.amount.toFixed(2)} (ref: ${event.payload.referenceId.slice(0, 8)}...)`;
    case 'CAPTURE_RELEASED':
      return `Released (ref: ${event.payload.referenceId.slice(0, 8)}...)`;
    default: {
      const _exhaustive: never = event;
      return JSON.stringify(_exhaustive);
    }
  }
}

function getAmountColor(event: StoredEvent): string {
  switch (event.type) {
    case 'DEPOSITED':
    case 'CAPTURE_RELEASED':
      return 'text-green-600';
    case 'WITHDRAWN':
    case 'CAPTURED':
      return 'text-red-600';
    default:
      return 'text-gray-600';
  }
}

function StatusBadge({ status }: { status: StoredEvent['status'] }) {
  switch (status) {
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Pending
        </span>
      );
    case 'synced':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Synced
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          Failed
        </span>
      );
    default: {
      const _exhaustive: never = status;
      return <span>{String(_exhaustive)}</span>;
    }
  }
}

export function EventList({ events }: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        No events yet
      </div>
    );
  }

  // Show newest first
  const sorted = [...events].sort((a, b) => b.sequenceNumber - a.sequenceNumber);

  return (
    <div className="divide-y divide-gray-100">
      {sorted.map(event => (
        <div
          key={event.id}
          className={`py-3 flex items-center justify-between ${event.status === 'pending' ? 'opacity-80' : ''}`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-mono text-gray-500">
              {event.sequenceNumber}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900">
                  {formatEventType(event.type)}
                </span>
                <StatusBadge status={event.status} />
              </div>
              <div className={`text-sm ${getAmountColor(event)}`}>
                {formatPayload(event)}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {new Date(event.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
