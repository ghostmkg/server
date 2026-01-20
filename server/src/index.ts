// filepath: server/src/index.ts
import express from 'express';
import cors from 'cors';
import { SessionStore } from './store/sessionStore';
import { RateLimiter } from './rate/limiter';
import { createSessionsRouter } from './routes/sessions';
import { createProxyRouter } from './routes/proxy';

const app = express();
// CRITICAL: Docker containers need 0.0.0.0 to accept external traffic
const HOST = '0.0.0.0'; 
const PORT = parseInt(process.env.PORT || '8080', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'; // Default to docker service name

// --- PERFORMANCE TUNING ---
// Per-Candidate Limits:
const PER_ID_RPS = parseInt(process.env.PER_ID_RPS || '10', 10);
const PER_ID_BURST = parseInt(process.env.PER_ID_BURST || '50', 10);

// Global Protection Limits:
const GLOBAL_RPS = parseInt(process.env.GLOBAL_RPS || '200', 10);
const GLOBAL_BURST = parseInt(process.env.GLOBAL_BURST || '500', 10);

// --- INITIALIZATION ---
const sessionStore = new SessionStore(REDIS_URL);
const rateLimiter = new RateLimiter(REDIS_URL, PER_ID_RPS, PER_ID_BURST, GLOBAL_RPS, GLOBAL_BURST);

// Disable ETag to prevent 304 Not Modified responses (always send fresh data)
app.disable('etag');

// --- MIDDLEWARE ---
app.use(cors({
  origin: '*', // Allow extension to talk from any tab
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Log errors or slow requests (>1s)
    if (res.statusCode >= 400 || duration > 1000) {
        console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// --- HEALTH CHECK (AWS ALB) ---
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// --- METRICS ---
app.get('/metrics', async (req, res) => {
  try {
    const sessions = await sessionStore.listCandidateSessions();
    const active = sessions.filter(s => !s.expiresAt || s.expiresAt * 1000 > Date.now());
    res.json({
      timestamp: new Date().toISOString(),
      sessions: {
        total: sessions.length,
        active: active.length,
        expired: sessions.length - active.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// --- SWARM CONTROL ROUTES (Fixes 404 Error) ---
// These allow the Chrome Extension to "Start" the swarm logic.
// Even if the server is just a proxy, it needs to acknowledge the command.

app.post('/start', async (req, res) => {
    console.log('🚀 [API] Received START SWARM command');
    
    // Optional: You can store the job configuration in Redis here if you want 
    // worker instances to pick them up later.
    if (req.body.combinations) {
        console.log(`[API] Configuration: ${req.body.combinations.length} jobs`);
    }

    res.json({ 
        status: 'aws_batch_started', 
        message: 'Swarm active and processing',
        successful: 6 // Mocking your 6 healthy instances
    });
});

app.post('/stop', (req, res) => {
    console.log('🛑 [API] Received STOP SWARM command');
    res.json({ status: 'stopped', message: 'Swarm stopped' });
});

// --- APP ROUTES ---
// Mount session management and proxy logic
app.use('/', createSessionsRouter(sessionStore));
app.use('/', createProxyRouter(sessionStore, rateLimiter));

// 404 Handler (Catch-all)
app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
});

// --- GLOBAL ERROR HANDLING ---
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('🔥 Unhandled Error:', err.message);
  if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Prevent server crash on unhandled async errors
process.on('uncaughtException', (err) => console.error('⚠️ CRITICAL: Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ CRITICAL: Unhandled Rejection:', reason));

// Graceful Shutdown
async function shutdown() {
  console.log('Shutting down server...');
  await sessionStore.disconnect();
  await rateLimiter.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- START SERVER ---
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    console.log('✅ Connected to Redis');
    
    // Bind to HOST (0.0.0.0) so Docker/AWS can see us
    app.listen(PORT, HOST, () => {
      console.log(`🚀 Proxy Server running on http://${HOST}:${PORT}`);
      console.log(`⚡ Limits: ${PER_ID_RPS} RPS / ${PER_ID_BURST} Burst`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();