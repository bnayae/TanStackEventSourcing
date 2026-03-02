import { getPendingEvents, markEventSynced, markEventFailed } from '../store/eventStore.js';
import type { StoredEvent } from '@funds/types';

const API_BASE = '/api';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ─── Batch Events Request ─────────────────────────────────────────────────────

interface BatchEventsRequest {
  accountId: string;
  events: Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: number;
    sequenceNumber: number;
  }>;
}

interface BatchEventsResponse {
  accepted: string[];
  rejected: string[];
  serverBalance: number;
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────

export class SyncEngine {
  private running = false;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private isSyncing = false;
  private onSyncCompleteCallbacks: Array<(accountIds: string[]) => void> = [];
  private manuallyOffline = false;

  setManuallyOffline(offline: boolean): void {
    this.manuallyOffline = offline;
    if (!offline && this.running && navigator.onLine) {
      console.log('[SyncEngine] Manual offline lifted — triggering sync');
      void this.sync();
    }
  }

  private get isOnline(): boolean {
    return navigator.onLine && !this.manuallyOffline;
  }

  onSyncComplete(callback: (accountIds: string[]) => void): () => void {
    this.onSyncCompleteCallbacks.push(callback);
    return () => {
      this.onSyncCompleteCallbacks = this.onSyncCompleteCallbacks.filter(cb => cb !== callback);
    };
  }

  private onlineListener = () => {
    console.log('[SyncEngine] Network is online — triggering sync');
    void this.sync();
  };

  private offlineListener = () => {
    console.log('[SyncEngine] Network is offline — sync paused');
    this.cancelScheduledSync();
  };

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    window.addEventListener('online', this.onlineListener);
    window.addEventListener('offline', this.offlineListener);

    // Initial sync if online
    if (this.isOnline) {
      void this.sync();
    }

    console.log('[SyncEngine] Started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    window.removeEventListener('online', this.onlineListener);
    window.removeEventListener('offline', this.offlineListener);

    this.cancelScheduledSync();
    console.log('[SyncEngine] Stopped');
  }

  // ─── Main Sync Loop ────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (!this.isOnline || !this.running || this.isSyncing) return;

    this.isSyncing = true;

    try {
      const pendingEvents = await getPendingEvents();

      if (pendingEvents.length === 0) {
        this.retryCount = 0;
        return;
      }

      console.log(`[SyncEngine] Syncing ${pendingEvents.length} pending event(s)`);

      // Group by accountId
      const byAccount = new Map<string, StoredEvent[]>();
      for (const event of pendingEvents) {
        const existing = byAccount.get(event.accountId) ?? [];
        existing.push(event);
        byAccount.set(event.accountId, existing);
      }

      // Sync each account's events in order
      let hasErrors = false;
      const syncedAccountIds: string[] = [];
      for (const [accountId, events] of byAccount) {
        const success = await this.syncAccountEvents(accountId, events);
        if (!success) {
          hasErrors = true;
        } else {
          syncedAccountIds.push(accountId);
        }
      }

      if (syncedAccountIds.length > 0) {
        for (const cb of this.onSyncCompleteCallbacks) {
          cb(syncedAccountIds);
        }
      }

      if (hasErrors) {
        this.scheduleRetry();
      } else {
        this.retryCount = 0;
      }
    } catch (err) {
      console.error('[SyncEngine] Unexpected error during sync:', err);
      this.scheduleRetry();
    } finally {
      this.isSyncing = false;
    }
  }

  // ─── Sync Account Events ───────────────────────────────────────────────────

  private async syncAccountEvents(
    accountId: string,
    events: StoredEvent[]
  ): Promise<boolean> {
    const request: BatchEventsRequest = {
      accountId,
      events: events.map(e => ({
        id: e.id,
        type: e.type,
        payload: e.payload as unknown as Record<string, unknown>,
        createdAt: e.createdAt,
        sequenceNumber: e.sequenceNumber,
      })),
    };

    try {
      const response = await fetch(`${API_BASE}/events/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (response.status === 409) {
        // Sequence conflict — mark all events as failed
        console.warn(`[SyncEngine] Sequence conflict for account ${accountId}`);
        for (const event of events) {
          await markEventFailed(event.id);
        }
        return false;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as BatchEventsResponse;

      // Mark accepted events as synced
      for (const acceptedId of data.accepted) {
        await markEventSynced(acceptedId);
      }

      // Mark rejected events as failed
      for (const rejectedId of data.rejected) {
        await markEventFailed(rejectedId);
      }

      console.log(
        `[SyncEngine] Account ${accountId}: ` +
        `${data.accepted.length} accepted, ${data.rejected.length} rejected, ` +
        `serverBalance=${data.serverBalance}`
      );

      return data.rejected.length === 0;
    } catch (err) {
      console.error(`[SyncEngine] Error syncing account ${accountId}:`, err);

      if (this.retryCount >= MAX_RETRIES) {
        console.warn(`[SyncEngine] Max retries (${MAX_RETRIES}) reached for account ${accountId}, marking events as failed`);
        for (const event of events) {
          await markEventFailed(event.id);
        }
      }

      return false;
    }
  }

  // ─── Retry Scheduling ──────────────────────────────────────────────────────

  private scheduleRetry(): void {
    if (!this.running) return;

    this.retryCount = Math.min(this.retryCount + 1, MAX_RETRIES);
    const delay = BASE_DELAY_MS * Math.pow(2, this.retryCount - 1);

    console.log(`[SyncEngine] Scheduling retry in ${delay}ms (attempt ${this.retryCount}/${MAX_RETRIES})`);

    this.cancelScheduledSync();
    this.syncTimeout = setTimeout(() => {
      void this.sync();
    }, delay);
  }

  private cancelScheduledSync(): void {
    if (this.syncTimeout !== null) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
  }

  // ─── Manual trigger ────────────────────────────────────────────────────────

  triggerSync(): void {
    void this.sync();
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

export const syncEngine = new SyncEngine();
