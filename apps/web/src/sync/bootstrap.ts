import { db } from '../db/client.js';
import type { DBEvent } from '../db/DBEvent.js';
import type { AccountSnapshot } from '@funds/types';

const API_BASE = '/api';

interface RawEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sequenceNumber: number;
  createdAt: number;
}

interface EventsAfterSeqResponse {
  accountId: string;
  events: RawEvent[];
}

/**
 * Two-phase snapshot bootstrap:
 *
 * Phase 1 — fetch GET /api/accounts (server aggregates).
 *   For each account:
 *     - If no local events exist: record the server snapshot as a synthetic
 *       baseline so the UI renders immediately without event replay.
 *     - If local events exist: determine the highest local sequenceNumber.
 *
 * Phase 2 — for each account, fetch events missing from IndexedDB via
 *   GET /api/accounts/:id/events?afterSeq=<localMaxSeq>
 *   and upsert them as 'synced' events.
 *
 * Returns the list of accountIds that were bootstrapped (for query invalidation).
 */
export async function bootstrapFromSnapshots(): Promise<string[]> {
  let snapshots: AccountSnapshot[];

  try {
    const response = await fetch(`${API_BASE}/accounts`);
    if (!response.ok) {
      console.warn(`[bootstrap] GET /api/accounts failed: ${response.status}`);
      return [];
    }
    snapshots = (await response.json()) as AccountSnapshot[];
  } catch (err) {
    console.warn('[bootstrap] Could not reach server for snapshot bootstrap:', err);
    return [];
  }

  if (snapshots.length === 0) return [];

  console.log(`[bootstrap] Received ${snapshots.length} account snapshot(s) from server`);

  const bootstrappedAccountIds: string[] = [];

  for (const snapshot of snapshots) {
    const { accountId, lastSeq } = snapshot;

    // Find the max sequenceNumber already stored locally for this account
    const localEvents = await db.events
      .where('accountId')
      .equals(accountId)
      .sortBy('sequenceNumber');

    const localMaxSeq = localEvents.length > 0
      ? (localEvents[localEvents.length - 1]?.sequenceNumber ?? 0)
      : 0;

    // If no local events exist at all, seed a synthetic ACCOUNT_CREATED-like
    // baseline by inserting a placeholder that carries the snapshot state.
    // We do this by fetching all missing events from the server instead —
    // fetching afterSeq=0 gives us all events, which is correct for cold start.
    const fetchAfterSeq = Math.min(localMaxSeq, lastSeq);

    // Fetch missing events from server
    try {
      const eventsRes = await fetch(
        `${API_BASE}/accounts/${accountId}/events?afterSeq=${fetchAfterSeq}`
      );

      if (!eventsRes.ok) {
        console.warn(`[bootstrap] Failed to fetch events for ${accountId}: ${eventsRes.status}`);
        continue;
      }

      const body = (await eventsRes.json()) as EventsAfterSeqResponse;
      const serverEvents = body.events;

      if (serverEvents.length > 0) {
        // Upsert all fetched events as 'synced'
        const dbEvents: DBEvent[] = serverEvents.map(e => ({
          id: e.id,
          accountId,
          type: e.type as DBEvent['type'],
          payload: e.payload,
          createdAt: e.createdAt,
          sequenceNumber: e.sequenceNumber,
          status: 'synced' as const,
          syncedAt: Date.now(),
        }));

        await db.events.bulkPut(dbEvents);
        console.log(
          `[bootstrap] Upserted ${dbEvents.length} event(s) for account ${accountId} ` +
          `(afterSeq=${fetchAfterSeq})`
        );
      }

      bootstrappedAccountIds.push(accountId);
    } catch (err) {
      console.warn(`[bootstrap] Error fetching events for ${accountId}:`, err);
    }
  }

  return bootstrappedAccountIds;
}
