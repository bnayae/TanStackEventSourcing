# Funds Management System

A client-side funds management app implementing event-sourcing with offline-first capability.

## Tech Stack

- **Monorepo**: Turborepo
- **Language**: TypeScript 5 (strict)
- **Framework**: React 19
- **Routing**: TanStack Router
- **Server state**: TanStack Query
- **Local persistence**: Dexie (IndexedDB)
- **Styling**: Tailwind CSS
- **Build**: Vite (client), tsc/tsx (server)
- **Backend**: Node.js + Express
- **ORM**: Prisma
- **Database**: PostgreSQL 16
- **Containerization**: Docker Compose

## Setup Instructions

### 1. Install dependencies

From the root of the monorepo:

```bash
npm install
```

### 2. Start PostgreSQL

```bash
docker compose up -d
```

Wait for the container to be healthy before proceeding.

### 3. Generate Prisma client and run migrations

```bash
npm run db:setup
```

This runs `prisma generate` then `prisma migrate deploy` in `apps/api`.

### 4. Start development servers

From the root:

```bash
npm run dev
```

This starts:
- Web app at http://localhost:5173
- API server at http://localhost:3000

## Project Structure

```
/
├── turbo.json
├── package.json
├── tsconfig.base.json
├── packages/
│   └── types/          # Shared domain types & event definitions
├── apps/
│   ├── web/            # React client (Vite)
│   └── api/            # Node.js + Express backend
└── docker-compose.yml
```

## Architecture

### Event Sourcing

All state changes are represented as immutable events stored locally in IndexedDB (via Dexie). The client computes account state by replaying events. Events are synced to the server in the background.

### Offline-First

The app works fully offline. When offline:
- Events are stored locally with `status: 'pending'`
- Optimistic balance is computed from local events
- A pending events counter shows unsynced changes

When back online, the sync engine batches pending events and sends them to the API.

### Sync Engine

The sync engine:
1. Reads all `pending` events ordered by `(accountId, sequenceNumber)`
2. Sends batches per account to `POST /api/events/batch`
3. On success: marks events as `synced`
4. On failure: retries with exponential backoff; marks as `failed` after 3 retries

## API

### POST /api/events/batch

Accepts a batch of events for a single account.

```json
{
  "accountId": "uuid",
  "events": [
    {
      "id": "uuid",
      "type": "DEPOSITED",
      "payload": { "amount": 100 },
      "createdAt": 1704067200000,
      "sequenceNumber": 1
    }
  ]
}
```

### GET /api/accounts/:accountId/balance

Returns the authoritative server balance.

```json
{
  "accountId": "uuid",
  "ownerName": "Alice",
  "balance": 250.00,
  "lastSeq": 5,
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```
