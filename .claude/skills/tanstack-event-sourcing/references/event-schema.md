# Event Schema Reference

## Table of Contents
1. [Base Types](#base-types)
2. [Payload Interfaces](#payload-interfaces)
3. [Discriminated Union](#discriminated-union)
4. [StoredEvent](#storedevent)
5. [Type Guards](#type-guards)
6. [State Computation](#state-computation)
7. [Zod Validation (server)](#zod-validation-server)
8. [Template — New Event Checklist](#template--new-event-checklist)

---

## Base Types

```ts
// packages/types/src/index.ts

export type EventType =
  | 'ENTITY_CREATED'
  | 'ACTION_PERFORMED'
  // ... add yours here

export type SyncStatus = 'pending' | 'synced' | 'failed';

export interface BaseEventFields {
  id: string;           // UUID v4, client-generated
  aggregateId: string;  // The entity this event belongs to
  createdAt: number;    // Unix timestamp ms (Date.now())
  sequenceNumber: number; // Monotonically increasing per aggregateId, starts at 0
}
```

---

## Payload Interfaces

One interface per event type. Keep payloads minimal — only raw facts, no derived values.

```ts
export interface EntityCreatedPayload {
  name: string;
  // add fields needed to reconstruct state for this event
}

export interface ActionPerformedPayload {
  amount: number;
  referenceId?: string;
}
```

---

## Discriminated Union

```ts
export interface EntityCreatedEvent extends BaseEventFields {
  type: 'ENTITY_CREATED';
  payload: EntityCreatedPayload;
}

export interface ActionPerformedEvent extends BaseEventFields {
  type: 'ACTION_PERFORMED';
  payload: ActionPerformedPayload;
}

// The canonical union — add every event type here
export type MyEvent =
  | EntityCreatedEvent
  | ActionPerformedEvent;
```

---

## StoredEvent

`StoredEvent` extends the domain event with client sync state. This is what lives in Dexie and what your hooks return.

```ts
export type StoredEvent = MyEvent & {
  status: SyncStatus;
  syncedAt?: number;  // Unix ms, set when status becomes 'synced'
};
```

---

## Type Guards

Generate one per event variant for narrowing in handlers:

```ts
export function isEntityCreatedEvent(e: MyEvent): e is EntityCreatedEvent {
  return e.type === 'ENTITY_CREATED';
}

export function isActionPerformedEvent(e: MyEvent): e is ActionPerformedEvent {
  return e.type === 'ACTION_PERFORMED';
}
```

---

## State Computation

The canonical reducer. Lives in the shared types package so both client and server use identical logic.

```ts
export interface AggregateState {
  aggregateId: string;
  name: string;
  confirmedBalance: number;
  optimisticBalance: number;
}

export function computeStateFromEvents(
  aggregateId: string,
  events: readonly MyEvent[]
): AggregateState {
  let name = '';
  let balance = 0;

  for (const event of events) {
    switch (event.type) {
      case 'ENTITY_CREATED':
        name = event.payload.name;
        break;
      case 'ACTION_PERFORMED':
        balance += event.payload.amount;
        break;
      default: {
        // TypeScript exhaustive check — will fail to compile if a case is missing
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return { aggregateId, name, confirmedBalance: balance, optimisticBalance: balance };
}
```

### Client variant — confirmed vs optimistic split

The client version of `computeState` takes `StoredEvent[]` and separates by sync status:

```ts
export function computeClientState(events: readonly StoredEvent[]): ClientAggregateState {
  let name = '';
  let confirmedBalance = 0;
  let pendingDelta = 0;

  for (const event of events) {
    const confirmed = event.status === 'synced';
    switch (event.type) {
      case 'ENTITY_CREATED':
        name = event.payload.name;
        break;
      case 'ACTION_PERFORMED': {
        const delta = event.payload.amount;
        if (confirmed) confirmedBalance += delta;
        else pendingDelta += delta;
        break;
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    aggregateId: events[0]?.aggregateId ?? '',
    name,
    balance: confirmedBalance + pendingDelta,
    pendingBalance: pendingDelta,
  };
}
```

---

## Zod Validation (server)

Mirror the TypeScript union in Zod for runtime validation on the Express route:

```ts
import { z } from 'zod';

const baseFields = {
  id: z.string().uuid(),
  createdAt: z.number().int().positive(),
  sequenceNumber: z.number().int().nonnegative(),
};

const BatchEventItemSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseFields,
    type: z.literal('ENTITY_CREATED'),
    payload: z.object({ name: z.string() }),
  }),
  z.object({
    ...baseFields,
    type: z.literal('ACTION_PERFORMED'),
    payload: z.object({ amount: z.number() }),
  }),
]);

const BatchEventsRequestSchema = z.object({
  aggregateId: z.string().uuid(),
  events: z.array(BatchEventItemSchema).min(1),
});
```

---

## Template — New Event Checklist

When adding a new event type:

- [ ] Add `'NEW_EVENT_TYPE'` to `EventType` union
- [ ] Add `NewEventPayload` interface
- [ ] Add `NewEvent extends BaseEventFields { type: 'NEW_EVENT_TYPE'; payload: NewEventPayload }`
- [ ] Add to `MyEvent` discriminated union
- [ ] Add `isNewEvent` type guard
- [ ] Add `case 'NEW_EVENT_TYPE':` to `computeStateFromEvents` (server replay)
- [ ] Add `case 'NEW_EVENT_TYPE':` to `computeClientState` (client confirmed/pending split)
- [ ] Add `z.object({ type: z.literal('NEW_EVENT_TYPE'), ... })` to Zod `discriminatedUnion`
- [ ] Add `WHEN 'NEW_EVENT_TYPE' THEN ...` to the PostgreSQL trigger
- [ ] Update Dexie `dbEventToStoredEvent` switch (if payload needs type coercion)
