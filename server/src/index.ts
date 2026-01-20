// filepath: server/src/index.ts
import express from 'express';
import cors from 'cors';
import { SessionStore } from './store/sessionStore';
import { RateLimiter } from './rate/limiter';
import { createSessionsRouter } from './routes/sessions';
import { createProxyRouter } from './routes/proxy';

const app = express();
const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// HIGH PERFORMANCE TUNING:
// RPS = 10: Allows fast sustained polling
// BURST = 50: Allows immediate rapid-fire requests when a slot is found
const PER_ID_RPS = parseInt(process.env.PER_ID_RPS || '10', 10);
const PER_ID_BURST = parseInt(process.env.PER_ID_BURST || '50', 10);

// Global Proxy Limits (Scalability)
const GLOBAL_RPS = parseInt(process.env.GLOBAL_RPS || '200', 10);
const GLOBAL_BURST = parseInt(process.env.GLOBAL_BURST || '500', 10);

// Initialize stores
const sessionStore = new SessionStore(REDIS_URL);
const rateLimiter = new RateLimiter(REDIS_URL, PER_ID_RPS, PER_ID_BURST, GLOBAL_RPS, GLOBAL_BURST);

// Disable ETag to prevent 304s
app.disable('etag');

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Log only slow requests (>1s) or errors to keep console clean
    if (res.statusCode >= 400 || duration > 1000) {
        console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const sessions = await sessionStore.listCandidateSessions();
    const activeSessions = sessions.filter(s => !s.expiresAt || s.expiresAt * 1000 > Date.now());
    res.json({
      sessions: {
        total: sessions.length,
        active: activeSessions.length,
        expired: sessions.length - activeSessions.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Routes
app.use('/', createSessionsRouter(sessionStore));
app.use('/', createProxyRouter(sessionStore, rateLimiter));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// Global Error Handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// --- CRITICAL CRASH PREVENTION ---
// These prevent the server from exiting on connection errors
process.on('uncaughtException', (err) => {
    console.error('⚠️ CRITICAL: Uncaught Exception:', err.message);
    // Keep running!
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ CRITICAL: Unhandled Rejection:', reason);
    // Keep running!
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await sessionStore.disconnect();
  await rateLimiter.disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    console.log('Connected to Redis');
    app.listen(PORT, () => {
      console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
      console.log(`⚡ Rate Limits: ${PER_ID_RPS} RPS (Burst ${PER_ID_BURST}) per candidate`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();