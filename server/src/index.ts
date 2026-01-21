// filepath: server/src/index.ts
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch'; 
import { SessionStore } from './store/sessionStore';
import { RateLimiter } from './rate/limiter';
import { JobQueue } from './store/queue'; // Import the new Queue class
import { createSessionsRouter } from './routes/sessions';
import { createProxyRouter } from './routes/proxy';

const app = express();
const HOST = '0.0.0.0'; 
const PORT = parseInt(process.env.PORT || '8080', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// --- CONFIG ---
const PER_ID_RPS = parseInt(process.env.PER_ID_RPS || '10', 10);
const PER_ID_BURST = parseInt(process.env.PER_ID_BURST || '50', 10);
const GLOBAL_RPS = parseInt(process.env.GLOBAL_RPS || '200', 10);
const GLOBAL_BURST = parseInt(process.env.GLOBAL_BURST || '500', 10);

// --- INITIALIZATION ---
const sessionStore = new SessionStore(REDIS_URL);
const rateLimiter = new RateLimiter(REDIS_URL, PER_ID_RPS, PER_ID_BURST, GLOBAL_RPS, GLOBAL_BURST);
const jobQueue = new JobQueue(REDIS_URL); // Initialize Queue

// --- WORKER CLASS ---
class JobWorker {
    private active = true;

    constructor(
        private jobId: string,
        private scheduleId: string,
        private candidateId: string,
        private authToken: string,
        private cookies: string
    ) {
        this.startLoop();
    }

    async startLoop() {
        // console.log(`[Worker] 🟢 Starting ${this.candidateId.slice(-4)} on ${this.jobId}`);
        const domain = this.jobId.includes('JOB-US') ? 'hiring.amazon.com' : 'hiring.amazon.ca';
        
        while (this.active) {
            try {
                // ... Your existing logic (create/update app) ...
                // Adding a random delay to prevent all 6 instances hitting API at exact same millisecond
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
            } catch (err) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    stop() {
        this.active = false;
    }
}

// Local array to track what THIS instance is running
const localWorkers: JobWorker[] = [];

// --- CONSUMER LOOP (The Magic Part) ---
// This runs on EVERY instance. It constantly checks Redis for new work.
async function startTaskConsumer() {
    console.log('👀 specific instance started watching for work...');
    
    setInterval(async () => {
        // 1. Try to steal a task from Redis
        const taskData = await jobQueue.getNextTask();
        
        if (taskData) {
            console.log(`[Consumer] ⚡ Picked up task for ${taskData.candidateId}`);
            
            const worker = new JobWorker(
                taskData.jobId,
                taskData.scheduleId,
                taskData.candidateId,
                taskData.authToken,
                taskData.cookieHeader
            );
            localWorkers.push(worker);
        }
    }, 1000); // Check every second (or faster if you want)
}


app.disable('etag');
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health Check
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.get('/', (req, res) => res.status(200).send('OK')); 

// --- API ROUTES ---

app.post('/start', async (req, res) => {
    console.log('🚀 [API] Received START command (Manager Role)');
    
    // NOTE: Extension now sends an ARRAY of sessions (candidates) and combinations
    const { combinations, sessions } = req.body;

    // Validation
    if (!sessions || !Array.isArray(sessions) || !combinations) {
        return res.status(400).json({ status: 'failed', message: 'Invalid payload: Need sessions array and combinations' });
    }

    // 1. Generate ALL Tasks (Cross Product: 24 candidates * 8 jobs = 192 Tasks)
    const allTasks = [];
    
    for (const session of sessions) {
        // Assume session object has { candidateId, authToken, cookieHeader }
        for (const job of combinations) {
            if (job.jobId && job.scheduleId) {
                allTasks.push({
                    jobId: job.jobId,
                    scheduleId: job.scheduleId,
                    candidateId: session.candidateId,
                    authToken: session.authToken || req.body.authToken, // Fallback if token is global
                    cookieHeader: session.cookieHeader || req.body.cookieHeader
                });
            }
        }
    }

    // 2. Push to Redis (All 6 instances will start grabbing these)
    await jobQueue.addTasks(allTasks);

    res.json({ 
        status: 'aws_batch_started', 
        message: `Distributed ${allTasks.length} tasks to swarm`,
        successful: 6 
    });
});

app.post('/stop', async (req, res) => {
    console.log('🛑 [API] Received STOP command');
    // Broadcast stop signal to ALL instances via Redis
    await jobQueue.broadcastStop();
    res.json({ status: 'stopped', message: 'Stop signal broadcasted' });
});

// --- ROUTES ---
app.use('/', createSessionsRouter(sessionStore));
app.use('/', createProxyRouter(sessionStore, rateLimiter));


// --- SETUP & START ---
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    await jobQueue.connect(); // Connect to Queue
    
    // 1. Start the Consumer Loop immediately
    startTaskConsumer();

    // 2. Listen for GLOBAL Stop Signal
    jobQueue.onStop(() => {
        console.log(`[Event] 🛑 Stopping ${localWorkers.length} local workers`);
        localWorkers.forEach(w => w.stop());
        localWorkers.length = 0;
    });

    app.listen(PORT, HOST, () => {
      console.log(`🚀 Node is running on http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();