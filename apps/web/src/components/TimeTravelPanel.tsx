import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TimeTravelResponse, StoredEvent } from '@funds/types';

interface TimeTravelPanelProps {
  accountId: string;
  currentBalance: number;
  events: StoredEvent[];
}

type Mode = 'datetime' | 'events-back' | 'duration-back';

async function fetchTimeTravelState(accountId: string, atMs: number): Promise<TimeTravelResponse> {
  const res = await fetch(`/api/accounts/${accountId}/state?at=${atMs}`);
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<TimeTravelResponse>;
}

/** Parse "HH:mm:ss" → total milliseconds, or null if the string is invalid. */
function parseDurationMs(value: string): number | null {
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map(Number);
  if (
    h === undefined || m === undefined || s === undefined ||
    !isFinite(h) || !isFinite(m) || !isFinite(s) ||
    h < 0 || m < 0 || m > 59 || s < 0 || s > 59
  ) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

/** Summarise an event's payload in a short human-readable string. */
function eventSummary(e: StoredEvent): string {
  switch (e.type) {
    case 'ACCOUNT_CREATED': return `Created — ${e.payload.ownerName}`;
    case 'DEPOSITED':        return `Deposit +$${e.payload.amount.toFixed(2)}`;
    case 'WITHDRAWN':        return `Withdrawal −$${e.payload.amount.toFixed(2)}`;
    case 'CAPTURED':         return `Capture −$${e.payload.amount.toFixed(2)}`;
    case 'CAPTURE_RELEASED': return `Release ref:${e.payload.referenceId.slice(0, 8)}`;
  }
}

export function TimeTravelPanel({ accountId, currentBalance, events }: TimeTravelPanelProps) {
  const [mode, setMode] = useState<Mode>('datetime');

  // per-mode input values
  const [selectedDatetime, setSelectedDatetime] = useState('');
  const [eventsBack, setEventsBack] = useState('');
  const [durationStr, setDurationStr] = useState('');

  // cursor: index into syncedEvents that the current view is anchored to.
  // null = not yet positioned (no result yet).
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);

  // how many events to show in the event dropdown (default 10)
  const [showCount, setShowCount] = useState(10);

  // Synced events sorted ascending — the navigable timeline
  const syncedEvents = useMemo(
    () =>
      events
        .filter(e => e.status === 'synced')
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber),
    [events]
  );

  // ── Target ms from mode inputs ───────────────────────────────────────────────

  /** ms from the input controls (ignores cursor navigation). */
  const inputTargetMs = useMemo<number | null>(() => {
    switch (mode) {
      case 'datetime': {
        if (!selectedDatetime) return null;
        const ms = new Date(selectedDatetime).getTime();
        return isNaN(ms) ? null : ms;
      }
      case 'events-back': {
        const n = parseInt(eventsBack, 10);
        if (!isFinite(n) || n <= 0 || syncedEvents.length === 0) return null;
        const idx = Math.max(0, syncedEvents.length - n);
        return syncedEvents[idx]?.createdAt ?? null;
      }
      case 'duration-back': {
        const durationMs = parseDurationMs(durationStr);
        if (durationMs === null) return null;
        return Date.now() - durationMs;
      }
    }
  }, [mode, selectedDatetime, eventsBack, durationStr, syncedEvents]);

  /**
   * The actual query target:
   * - If the cursor has been set (by navigation), use the cursor event's createdAt.
   * - Otherwise fall back to the input-derived ms.
   */
  const targetMs = useMemo<number | null>(() => {
    if (cursorIndex !== null) {
      return syncedEvents[cursorIndex]?.createdAt ?? null;
    }
    return inputTargetMs;
  }, [cursorIndex, syncedEvents, inputTargetMs]);

  const isActive = targetMs !== null;

  // ── Query ────────────────────────────────────────────────────────────────────

  const { data, isLoading, error } = useQuery({
    queryKey: ['time-travel', accountId, targetMs],
    queryFn: () => fetchTimeTravelState(accountId, targetMs!),
    enabled: isActive,
    staleTime: Infinity,
  });

  // When a result arrives, anchor the cursor to the matching event in syncedEvents.
  // This seeds the navigator when the user first gets a result from any input mode.
  useEffect(() => {
    if (data === undefined) return;
    const idx = syncedEvents.findIndex(e => e.sequenceNumber === data.lastSeq);
    if (idx !== -1) setCursorIndex(idx);
  }, [data, syncedEvents]);

  // Reset cursor when inputs change (user is specifying a new starting point).
  useEffect(() => {
    setCursorIndex(null);
  }, [inputTargetMs]);

  // ── Navigation ───────────────────────────────────────────────────────────────

  const atFirst = cursorIndex !== null && cursorIndex <= 0;
  const atLast  = cursorIndex !== null && cursorIndex >= syncedEvents.length - 1;

  function goBack() {
    setCursorIndex(prev =>
      prev === null ? null : Math.max(0, prev - 1)
    );
  }

  function goForward() {
    setCursorIndex(prev =>
      prev === null ? null : Math.min(syncedEvents.length - 1, prev + 1)
    );
  }

  // ── Event list slice ─────────────────────────────────────────────────────────

  /** Events visible in the dropdown: up to showCount events ending at cursor. */
  const visibleEvents = useMemo<StoredEvent[]>(() => {
    if (cursorIndex === null) return [];
    const endIdx = cursorIndex + 1;          // inclusive of cursor event
    const startIdx = Math.max(0, endIdx - showCount);
    return syncedEvents.slice(startIdx, endIdx);
  }, [cursorIndex, syncedEvents, showCount]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function handleClear() {
    setSelectedDatetime('');
    setEventsBack('');
    setDurationStr('');
    setCursorIndex(null);
  }

  function switchMode(m: Mode) {
    setMode(m);
    handleClear();
  }

  const targetLabel = useMemo<string>(() => {
    if (targetMs === null) return '';
    const dateStr = new Date(targetMs).toLocaleString();
    if (cursorIndex !== null) {
      const e = syncedEvents[cursorIndex];
      return e ? `Seq #${e.sequenceNumber} — ${dateStr}` : dateStr;
    }
    switch (mode) {
      case 'datetime':      return dateStr;
      case 'events-back': {
        const n = parseInt(eventsBack, 10);
        return `${n} event${n === 1 ? '' : 's'} back — ${dateStr}`;
      }
      case 'duration-back': return `${durationStr} ago — ${dateStr}`;
    }
  }, [targetMs, cursorIndex, syncedEvents, mode, selectedDatetime, eventsBack, durationStr]);

  const maxDatetime = new Date().toISOString().slice(0, 16);

  const tabClass = (m: Mode) =>
    `px-3 py-1.5 text-sm rounded-lg transition-colors ${
      mode === m
        ? 'bg-blue-600 text-white'
        : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
    }`;

  const navBtnClass = (disabled: boolean) =>
    `px-3 py-1 text-sm rounded-lg border transition-colors ${
      disabled
        ? 'border-gray-200 text-gray-300 cursor-not-allowed'
        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
    }`;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Time Travel</h2>

      {/* Mode selector */}
      <div className="flex gap-2 mb-4">
        <button className={tabClass('datetime')} onClick={() => switchMode('datetime')}>
          Date &amp; Time
        </button>
        <button className={tabClass('events-back')} onClick={() => switchMode('events-back')}>
          N Events Back
        </button>
        <button className={tabClass('duration-back')} onClick={() => switchMode('duration-back')}>
          Duration Back
        </button>
      </div>

      {/* Input area */}
      <div className="flex items-center gap-2 mb-4">
        {mode === 'datetime' && (
          <input
            type="datetime-local"
            value={selectedDatetime}
            max={maxDatetime}
            onChange={e => setSelectedDatetime(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}

        {mode === 'events-back' && (
          <>
            <input
              type="number"
              min={1}
              max={syncedEvents.length}
              value={eventsBack}
              onChange={e => setEventsBack(e.target.value)}
              placeholder={`1 – ${syncedEvents.length}`}
              className="w-36 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400 whitespace-nowrap">
              events back ({syncedEvents.length} synced)
            </span>
          </>
        )}

        {mode === 'duration-back' && (
          <input
            type="text"
            value={durationStr}
            onChange={e => setDurationStr(e.target.value)}
            placeholder="HH:mm:ss"
            pattern="\d{1,2}:\d{2}:\d{2}"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}

        {isActive && (
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Placeholder hint */}
      {!isActive && (
        <p className="text-sm text-gray-400">
          {mode === 'datetime'      && 'Select a date and time to view the historical balance.'}
          {mode === 'events-back'   && 'Enter how many synced events to step back from the latest.'}
          {mode === 'duration-back' && 'Enter a duration (e.g. 01:30:00) to look back from now.'}
        </p>
      )}

      {isActive && isLoading && (
        <div className="text-sm text-gray-500 animate-pulse">Loading historical state…</div>
      )}

      {isActive && error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error instanceof Error ? error.message : 'Failed to load historical state'}
        </div>
      )}

      {isActive && data && (
        <>
          {/* ── Result banner ── */}
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-3">
            <div className="text-xs font-medium text-amber-700 uppercase tracking-wide">
              Historical snapshot — {targetLabel}
            </div>

            {/* Balances */}
            <div className="flex items-baseline gap-4">
              <div>
                <div className="text-xs text-gray-500">Balance on date</div>
                <div className="text-xl font-bold text-amber-800">${data.balance.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Current balance</div>
                <div className="text-xl font-bold text-gray-700">${currentBalance.toFixed(2)}</div>
              </div>
            </div>

            {/* Meta */}
            <div className="text-xs text-gray-500 space-y-0.5">
              <div>Seq #{data.lastSeq} · Events replayed: {data.eventsReplayed}</div>
              {data.snapshotId !== null
                ? <div>Base snapshot ID: {data.snapshotId}</div>
                : <div>Replayed from genesis (no prior snapshot)</div>
              }
            </div>

            {/* ── Navigation ── */}
            {cursorIndex !== null && (
              <div className="flex items-center gap-2 pt-1 border-t border-amber-200">
                <button
                  onClick={goBack}
                  disabled={atFirst}
                  className={navBtnClass(atFirst)}
                  title="Previous event"
                >
                  ← Prev
                </button>
                <span className="text-xs text-gray-500 flex-1 text-center">
                  {cursorIndex + 1} / {syncedEvents.length}
                </span>
                <button
                  onClick={goForward}
                  disabled={atLast}
                  className={navBtnClass(atLast)}
                  title="Next event"
                >
                  Next →
                </button>
              </div>
            )}
          </div>

          {/* ── Event list ── */}
          {cursorIndex !== null && visibleEvents.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Events up to this point
                </span>
                <select
                  value={showCount}
                  onChange={e => setShowCount(Number(e.target.value))}
                  className="text-xs border border-gray-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {[5, 10, 25, 50].map(n => (
                    <option key={n} value={n}>Last {n}</option>
                  ))}
                </select>
              </div>
              <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                {[...visibleEvents].reverse().map(e => {
                  const isCursor = e.sequenceNumber === syncedEvents[cursorIndex]?.sequenceNumber;
                  return (
                    <div
                      key={e.id}
                      className={`flex items-center gap-3 px-3 py-2 text-sm ${
                        isCursor ? 'bg-amber-50' : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-xs font-mono text-gray-400 w-10 shrink-0 text-right">
                        #{e.sequenceNumber}
                      </span>
                      <span className={`flex-1 ${isCursor ? 'font-medium text-amber-800' : 'text-gray-700'}`}>
                        {eventSummary(e)}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">
                        {new Date(e.createdAt).toLocaleTimeString()}
                      </span>
                      {isCursor && (
                        <span className="text-xs bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded font-medium">
                          current
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
