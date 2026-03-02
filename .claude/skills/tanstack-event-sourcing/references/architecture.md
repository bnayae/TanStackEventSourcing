# Architecture Reference

## Table of Contents
1. [Monorepo Structure](#monorepo-structure)
2. [API Routes Convention](#api-routes-convention)
3. [Batch Event API Contract](#batch-event-api-contract)
4. [Sequence Conflict Handling](#sequence-conflict-handling)
5. [Setup Commands](#setup-commands)

---

## Monorepo Structure

```
root/
├── package.json               # npm workspaces root
├── turbo.json                 # Turborepo pipeline
├── docker-compose.yml         # PostgreSQL for local dev
├── packages/
│   └── types/                 # Shared TypeScript types
│       └── src/index.ts       # FundsEvent union, computeStateFromEvents, type guards
└── apps/
    ├── api/                   # Express + Prisma backend (port 3000)
    │   ├── src/
    │   │   ├── index.ts       # Express app, route mounting
    │   │   └── routes/
    │   │       ├── events.ts  # POST /api/events/batch
    │   │       └── accounts.ts # GET /api/accounts/:id/balance, DELETE
    │   └── prisma/
    │       ├── schema.prisma
    │       └── migrations/
    └── web/                   # React 19 + Vite (port 5173)
        └── src/
            ├── main.tsx       # QueryClient, Router, syncEngine.start()
            ├── routeTree.gen.ts  # Manually written route tree
            ├── db/
            │   └── client.ts  # Dexie FundsDatabase
            ├── store/
            │   └── eventStore.ts  # addEvent, computeAccountState, getAccounts
            ├── sync/
            │   └── syncEngine.ts  # SyncEngine singleton
            ├── context/
            │   └── NetworkStatusContext.tsx
            ├── hooks/
            │   ├── useAccountEvents.ts
            │   ├── useAccounts.ts
            │   └── useNetworkStatus.ts
            └── routes/
                ├── __root.tsx
                ├── index.tsx
                ├── accounts.new.tsx
                ├── accounts.$id.tsx
                └── accounts.$id.balance.tsx
```

### Key package.json workspaces
```json
{
  "workspaces": ["packages/*", "apps/*"]
}
```

Shared types package is referenced as `"@funds/types": "*"` in app package.jsons.

### Vite dev proxy
In `apps/web/vite.config.ts`:
```ts
server: {
  proxy: {
    '/api': 'http://localhost:3000',
  },
},
```

---

## API Routes Convention

```
POST   /api/events/batch              → accept events for one account in sequence order
GET    /api/accounts/:id/balance      → server-confirmed balance from account_balances table
GET    /api/accounts/:id/events       → last 10 events for reconciliation
DELETE /api/accounts/:id             → delete account + events (dev/test utility)
```

All routes use Express `Router`, mounted in `apps/api/src/index.ts`:
```ts
app.use('/api/events', eventsRouter);
app.use('/api/accounts', accountsRouter);
```

---

## Batch Event API Contract

### Request
```ts
POST /api/events/batch
Content-Type: application/json

{
  "accountId": "uuid",
  "events": [
    {
      "id": "uuid",                  // client-generated UUID (idempotency key)
      "type": "DEPOSITED",
      "payload": { "amount": 100 },
      "createdAt": 1700000000000,    // Unix ms
      "sequenceNumber": 3            // monotonically increasing per account
    }
  ]
}
```

### Response — success
```ts
{
  "accepted": ["uuid1", "uuid2"],
  "rejected": [],
  "serverBalance": 450.00
}
```

### Response — sequence conflict (HTTP 409)
```ts
{
  "error": "Sequence conflict",
  "accepted": [],
  "rejected": ["uuid1"]
}
```

### Server processing logic
1. Sort events by `sequenceNumber`
2. `INSERT` each event individually (not in a transaction batch)
3. On `P2002` unique constraint violation on `(accountId, sequenceNumber)`:
   - Check if event `id` already exists → idempotent accept
   - Different event, same sequence → reject (sequence conflict)
4. Return `accepted`, `rejected`, and current `serverBalance` from `account_balances`

---

## Sequence Conflict Handling

The composite unique index `UNIQUE(account_id, sequence_number)` on the events table enforces ordering.

**Client**: Generates `sequenceNumber` by reading `MAX(sequenceNumber)` from local Dexie and adding 1. This is per-aggregate, starts at 0 for the first event.

**Conflict scenarios**:
| Scenario | HTTP Status | Client Action |
|---|---|---|
| Same event `id` already accepted | 200 (idempotent) | mark synced |
| Different event same seqNum | 409 | mark failed, surface to user |
| Network error | (throw) | exponential backoff retry |

**Idempotency**: Event `id` (UUID v4) is used as the primary key on the server. Sending the same event twice is safe — the second attempt is treated as already accepted.

---

## Setup Commands

```bash
# Install deps
npm install

# Start PostgreSQL
docker compose up -d

# Generate Prisma client + run migrations
cd apps/api
npx prisma generate
npx prisma migrate deploy

# Dev (both apps via Turborepo)
cd ../..
npm run dev
# → web: http://localhost:5173
# → api: http://localhost:3000
```

### Environment variables

`apps/api/.env`:
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/funds"
```

`apps/web/.env.development`:
```
VITE_ENABLE_OFFLINE_SIMULATION=true
```

`apps/web/.env.production`:
```
# Do NOT set VITE_ENABLE_OFFLINE_SIMULATION here
```
