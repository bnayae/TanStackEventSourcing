import type { StoredEvent } from '@funds/types';

export function getActiveCaptureReferenceIds(events: readonly StoredEvent[]): string[] {
  const captured = new Set<string>();
  const released = new Set<string>();

  for (const event of events) {
    if (event.type === 'CAPTURED') {
      captured.add(event.payload.referenceId);
    } else if (event.type === 'CAPTURE_RELEASED') {
      released.add(event.payload.referenceId);
    }
  }

  return Array.from(captured).filter(id => !released.has(id));
}
