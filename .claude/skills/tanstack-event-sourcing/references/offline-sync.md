# Offline Sync Reference

## Table of Contents
1. [Dexie Schema](#dexie-schema)
2. [addEvent()](#addevent)
3. [computeClientState()](#computeclientstate)
4. [SyncEngine](#syncengine)
5. [NetworkStatusContext](#networkstatuscontext)
6. [Offline Simulation Gate](#offline-simulation-gate)
7. [Wiring in main.tsx](#wiring-in-maintsx)

---

## Dexie Schema

```ts
// apps/web/src/db/client.ts
import Dexie, { type Table } from 'dexie';
import type { StoredEvent, EventType } from '@your-scope/types';

export interface DBEvent {
  id: string;             // Primary key (UUID)
  aggregateId: string;    // Index
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;      // Unix ms, Index
  sequenceNumber: number; // Index (scoped per aggregateId)
  status: 'pending' | 'synced' | 'failed';
  syncedAt?: number;      // Unix ms, set when synced
}

class AppDatabase extends Dexie {
  events!: Table<DBEvent, string>;

  constructor() {
    super('AppDatabase');
    this.version(1).stores({
      // id = primary key; compound index [aggregateId+sequenceNumber] for efficient per-aggregate queries
      events: 'id, aggregateId, createdAt, sequenceNumber, status, [aggregateId+sequenceNumber]',
    });
  }
}

export const db = new AppDatabase();

export function dbEventToStoredEvent(dbEvent: DBEvent): StoredEvent {
  const base = {
    id: dbEvent.id,
    aggregateId: dbEvent.aggregateId,
    createdAt: dbEvent.createdAt,
    sequenceNumber: dbEvent.sequenceNumber,
    status: dbEvent.status,
    ...(dbEvent.syncedAt !== undefined ? { syncedAt: dbEvent.syncedAt } : {}),
  };

  // Type-narrow the payload per event type to satisfy TypeScript
  switch (dbEvent.type) {
    case 'ENTITY_CREATED':
      return { ...base, type: 'ENTITY_CREATED', payload: { name: String(dbEvent.payload['name'] ?? '') } };
    case 'ACTION_PERFORMED':
      return { ...base, type: 'ACTION_PERFORMED', payload: { amount: Number(dbEvent.payload['amount'] ?? 0) } };
    // ... add a case per event type
    default: {
      const _exhaustive: never = dbEvent.type;
      throw new Error(`Unknown event type: ${String(_exhaustive)}`);
    }
  }
}
```

**Index rationale**:
- `aggregateId` → fast per-entity event queries
- `status` → fast pending event queries (`SyncEngine`)
- `[aggregateId+sequenceNumber]` → compound index for sorted per-entity replay
- `createdAt` → useful for time-range queries / debugging

---

## addEvent()

```ts
// apps/web/src/store/eventStore.ts
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client.js';

export async function addEvent(
  aggregateId: string,
  type: EventType,
  payload: EventPayload
): Promise<StoredEvent> {
  // Get current max sequence number for this aggregate
  const lastEvent = await db.events
    .where('aggregateId')
    .equals(aggregateId)
    .sortBy('sequenceNumber')
    .then(events => events[events.length - 1]);

  const sequenceNumber = lastEvent !== undefined ? lastEvent.sequenceNumber + 1 : 0;

  const dbEvent: DBEvent = {
    id: uuidv4(),
    aggregateId,
    type,
    payload: payload as Record<string, unknown>,
    createdAt: Date.now(),
    sequenceNumber,
    status: 'pending',
  };

  await db.events.add(dbEvent);
  return dbEventToStoredEvent(dbEvent);
}
```

After `db.events.add()`, any `useLiveQuery` subscribed to this aggregate's events will re-run automatically — no manual cache invalidation.

---

## computeClientState()

See [event-schema.md](event-schema.md#state-computation) for the full implementation. The key split:

```ts
// For each event in replay order:
const confirmed = event.status === 'synced';
if (confirmed) confirmedBalance += delta;
else pendingDelta += delta;

// Return:
{
  balance: confirmedBalance + pendingDelta,  // optimistic — what to display
  pendingBalance: pendingDelta,             // show in amber, explains the gap
}
```

---

## SyncEngine

```ts
// apps/web/src/sync/syncEngine.ts

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class SyncEngine {
  private running = false;
  private retryCount = 0;
  private isSyncing = false;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private onSyncCompleteCallbacks: Array<(aggregateIds: string[]) => void> = [];
  private manuallyOffline = false;

  // Called by NetworkStatusContext when toggle is flipped
  setManuallyOffline(offline: boolean): void {
    this.manuallyOffline = offline;
    if (!offline && this.running && navigator.onLine) {
      void this.sync(); // flush immediately when coming back online
    }
  }

  private get isOnline(): boolean {
    return navigator.onLine && !this.manuallyOffline;
  }

  // Subscribe to sync completions (e.g. to invalidate TanStack Query cache)
  onSyncComplete(callback: (aggregateIds: string[]) => void): () => void {
    this.onSyncCompleteCallbacks.push(callback);
    return () => {
      this.onSyncCompleteCallbacks = this.onSyncCompleteCallbacks.filter(cb => cb !== callback);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('online', this.onlineListener);
    window.addEventListener('offline', this.offlineListener);
    if (this.isOnline) void this.sync();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener('online', this.onlineListener);
    window.removeEventListener('offline', this.offlineListener);
    this.cancelScheduledSync();
  }

  private onlineListener = () => { void this.sync(); };
  private offlineListener = () => { this.cancelScheduledSync(); };

  async sync(): Promise<void> {
    if (!this.isOnline || !this.running || this.isSyncing) return;
    this.isSyncing = true;
    try {
      const pendingEvents = await getPendingEvents(); // from eventStore
      if (pendingEvents.length === 0) { this.retryCount = 0; return; }

      // Group by aggregateId for batching
      const byAggregate = new Map<string, StoredEvent[]>();
      for (const event of pendingEvents) {
        const group = byAggregate.get(event.aggregateId) ?? [];
        group.push(event);
        byAggregate.set(event.aggregateId, group);
      }

      let hasErrors = false;
      const syncedAggregateIds: string[] = [];

      for (const [aggregateId, events] of byAggregate) {
        const success = await this.syncAggregateEvents(aggregateId, events);
        if (success) syncedAggregateIds.push(aggregateId);
        else hasErrors = true;
      }

      if (syncedAggregateIds.length > 0) {
        for (const cb of this.onSyncCompleteCallbacks) cb(syncedAggregateIds);
      }
      if (hasErrors) this.scheduleRetry();
      else this.retryCount = 0;
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncAggregateEvents(aggregateId: string, events: StoredEvent[]): Promise<boolean> {
    try {
      const response = await fetch('/api/events/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregateId,
          events: events.map(e => ({
            id: e.id, type: e.type,
            payload: e.payload as Record<string, unknown>,
            createdAt: e.createdAt, sequenceNumber: e.sequenceNumber,
          })),
        }),
      });

      if (response.status === 409) {
        // Sequence conflict: mark all as failed, surface to user
        for (const event of events) await markEventFailed(event.id);
        return false;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as BatchEventsResponse;
      for (const id of data.accepted) await markEventSynced(id);
      for (const id of data.rejected) await markEventFailed(id);
      return data.rejected.length === 0;
    } catch {
      if (this.retryCount >= MAX_RETRIES) {
        for (const event of events) await markEventFailed(event.id);
      }
      return false;
    }
  }

  private scheduleRetry(): void {
    if (!this.running) return;
    this.retryCount = Math.min(this.retryCount + 1, MAX_RETRIES);
    const delay = BASE_DELAY_MS * Math.pow(2, this.retryCount - 1);
    this.cancelScheduledSync();
    this.syncTimeout = setTimeout(() => void this.sync(), delay);
  }

  private cancelScheduledSync(): void {
    if (this.syncTimeout !== null) { clearTimeout(this.syncTimeout); this.syncTimeout = null; }
  }

  triggerSync(): void { void this.sync(); }
}

export const syncEngine = new SyncEngine();
```

**Retry backoff schedule**: 1s → 2s → 4s (max 3 retries, then mark failed)

---

## NetworkStatusContext

```tsx
// apps/web/src/context/NetworkStatusContext.tsx
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { syncEngine } from '../sync/syncEngine.js';

interface NetworkStatusContextValue {
  status: 'online' | 'offline';
  isManuallyOffline: boolean;
  toggleManualOffline: () => void;
}

const NetworkStatusContext = createContext<NetworkStatusContextValue | null>(null);

export function NetworkStatusProvider({ children }: { children: ReactNode }) {
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [isManuallyOffline, setIsManuallyOffline] = useState(false);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  const toggleManualOffline = useCallback(() => {
    setIsManuallyOffline(prev => {
      const next = !prev;
      syncEngine.setManuallyOffline(next); // keep SyncEngine in sync
      return next;
    });
  }, []);

  const status = !browserOnline || isManuallyOffline ? 'offline' : 'online';

  return (
    <NetworkStatusContext.Provider value={{ status, isManuallyOffline, toggleManualOffline }}>
      {children}
    </NetworkStatusContext.Provider>
  );
}

export function useNetworkStatusContext(): NetworkStatusContextValue {
  const ctx = useContext(NetworkStatusContext);
  if (!ctx) throw new Error('useNetworkStatusContext must be used within NetworkStatusProvider');
  return ctx;
}
```

---

## Offline Simulation Gate

### Setup

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    'import.meta.env.VITE_ENABLE_OFFLINE_SIMULATION':
      JSON.stringify(process.env.VITE_ENABLE_OFFLINE_SIMULATION ?? 'false'),
  },
  // ... rest of config
});
```

`apps/web/.env.development`:
```
VITE_ENABLE_OFFLINE_SIMULATION=true
```

`apps/web/.env.production` — **do not add this variable**.

### Usage in components

```tsx
import { useNetworkStatusContext } from '../context/NetworkStatusContext.js';

function NetworkStatusBar() {
  const { status, isManuallyOffline, toggleManualOffline } = useNetworkStatusContext();

  return (
    <div>
      <span>{status === 'offline' ? 'Offline' : 'Online'}</span>

      {/* Only shown in non-prod environments where VITE_ENABLE_OFFLINE_SIMULATION=true */}
      {import.meta.env.VITE_ENABLE_OFFLINE_SIMULATION === 'true' && (
        <button onClick={toggleManualOffline}>
          {isManuallyOffline ? 'Go Online (sim)' : 'Simulate Offline'}
        </button>
      )}
    </div>
  );
}
```

**Why env gate instead of conditional import?**
Vite's `define` replaces the string at build time. In a production build, `'true' === 'true'` evaluates to `false`, and tree-shaking removes the button entirely. No runtime overhead, no dev-only UI leaking to prod.

---

## Wiring in main.tsx

```tsx
// apps/web/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { syncEngine } from './sync/syncEngine.js';
import { NetworkStatusProvider } from './context/NetworkStatusContext.js';
import { routeTree } from './routeTree.gen.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 30, retry: 2 } },
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}

// Start sync engine at app startup — handles online/offline events automatically
syncEngine.start();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NetworkStatusProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </NetworkStatusProvider>
  </React.StrictMode>
);
```

**Provider order matters**: `NetworkStatusProvider` wraps `QueryClientProvider` so any hook inside can access both. `syncEngine.start()` is called before render — the SyncEngine has no React dependency.
