import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { syncEngine } from './sync/syncEngine.js';
import { NetworkStatusProvider } from './context/NetworkStatusContext.js';

// Import the route tree
import { routeTree } from './routeTree.gen.js';

// ─── Tailwind ─────────────────────────────────────────────────────────────────
import './index.css';

// ─── Query Client ─────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30 seconds
      retry: 2,
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────────────────

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// ─── Start Sync Engine ────────────────────────────────────────────────────────

syncEngine.start();

// ─── Render ───────────────────────────────────────────────────────────────────

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <NetworkStatusProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </NetworkStatusProvider>
  </React.StrictMode>
);
