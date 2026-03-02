import express from 'express';
import cors from 'cors';
import { eventsRouter } from './routes/events.js';
import { accountsRouter } from './routes/accounts.js';

const app = express();
const PORT = process.env['PORT'] ?? 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/events', eventsRouter);
app.use('/api/accounts', accountsRouter);

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
) => {
  console.error('[API Error]', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err instanceof Error ? err.message : 'Unknown error',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[API] Server running on http://localhost:${PORT}`);
});

export default app;
