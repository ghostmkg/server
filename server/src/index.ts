// filepath: server/src/index.ts
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch'; 
import { SessionStore } from './store/sessionStore';
import { RateLimiter } from './rate/limiter';
import { JobQueue } from './store/queue'; 
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
const jobQueue = new JobQueue(REDIS_URL); 

// --- WORKER CLASS ---
// This class runs the actual job loop for a specific candidate + job combination
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
        const domain = this.jobId.includes('JOB-US') ? 'hiring.amazon.com' : 'hiring.amazon.ca';
        const countryCode = this.jobId.includes('JOB-US') ? 'US' : 'CA';

        // console.log(`[Worker] 🟢 Started: ${this.candidateId.slice(0,8)}... on ${this.jobId}`);

        while (this.active) {
            try {
                // 1. CREATE APPLICATION
                const createRes = await fetch(`https://${domain}/application/api/candidate-application/ds/create-application/`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-candidate-id': this.candidateId,
                        'cookie': this.cookies,
                        'authorization': this.authToken,
                        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    },
                    body: JSON.stringify({
                        jobId: this.jobId,
                        scheduleId: this.scheduleId,
                        candidateId: this.candidateId,
                        dspEnabled: true,
                        activeApplicationCheckEnabled: true
                    })
                });

                if (createRes.status === 200) {
                    const data: any = await createRes.json();
                    const appId = data.data?.applicationId;
                    
                    if (appId) {
                        console.log(`[Worker] ✅ App Created: ${appId} for ${this.candidateId.slice(0,5)}`);
                        // 2. UPDATE APPLICATION (Confirm)
                        await this.updateApplication(domain, appId);
                    }
                } else if (createRes.status === 429) {
                    // Backoff on rate limit
                    await new Promise(r => setTimeout(r, 5000));
                }

                // Polling Interval + Jitter (to prevent thundering herd)
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            } catch (err) {
                console.error(`[Worker] Error:`, err);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    async updateApplication(domain: string, applicationId: string) {
         try {
            await fetch(`https://${domain}/application/api/candidate-application/update-application`, {
                method: "PUT",
                headers: {
                    'content-type': 'application/json',
                    'x-candidate-id': this.candidateId,
                    'cookie': this.cookies,
                    'authorization': this.authToken
                },
                body: JSON.stringify({
                    applicationId,
                    candidateId: this.candidateId,
                    payload: { jobId: this.jobId, scheduleId: this.scheduleId },
                    type: "job-confirm", isCsRequest: true
                })
            });
         } catch(e) {}
    }

    stop() {
        this.active = false;
    }
}

// Local array to track what THIS specific instance is running
const localWorkers: JobWorker[] = [];

// --- CONSUMER LOOP ---
// Runs on EVERY instance. Checks Redis for work.
async function startTaskConsumer() {
    console.log('👀 Worker Node started. Watching queue...');
    
    setInterval(async () => {
        // Try to steal a task from Redis
        const taskData = await jobQueue.getNextTask();
        
        if (taskData) {
            console.log(`[Consumer] ⚡ Taken task: ${taskData.jobId} for ${taskData.candidateId.slice(0,5)}`);
            
            const worker = new JobWorker(
                taskData.jobId,
                taskData.scheduleId,
                taskData.candidateId,
                taskData.authToken,
                taskData.cookieHeader
            );
            localWorkers.push(worker);
        }
    }, 1000); // Check every second
}


// --- MIDDLEWARE ---
app.disable('etag');
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (res.statusCode >= 400 || duration > 1000) {
        console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// --- HEALTH CHECKS ---
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.get('/', (req, res) => res.status(200).send('OK')); 

// --- API ROUTES ---

app.post('/start', async (req, res) => {
    console.log('🚀 [API] Received START command');

    // --- 1. DYNAMIC INPUT NORMALIZATION ---
    // Always convert inputs to Arrays, handling legacy single-item format

    // Handle "Sessions" (Accounts)
    let sessions = [];
    if (Array.isArray(req.body.sessions) && req.body.sessions.length > 0) {
        sessions = req.body.sessions; 
    } else if (req.body.candidateId && req.body.authToken) {
        // Fallback: Single account
        sessions.push({
            candidateId: req.body.candidateId,
            authToken: req.body.authToken,
            cookieHeader: req.body.cookieHeader
        });
    }

    // Handle "Combinations" (Jobs)
    let jobs = [];
    if (Array.isArray(req.body.combinations) && req.body.combinations.length > 0) {
        jobs = req.body.combinations;
    } else if (req.body.jobId && req.body.scheduleId) {
        // Fallback: Single job
        jobs.push({
            jobId: req.body.jobId,
            scheduleId: req.body.scheduleId
        });
    }

    // --- 2. VALIDATION ---
    if (sessions.length === 0 || jobs.length === 0) {
        return res.status(400).json({ 
            status: 'failed', 
            message: `Invalid Input. Found ${sessions.length} accounts and ${jobs.length} jobs.` 
        });
    }

    // --- 3. GENERATE TASKS (Cross-Product) ---
    const allTasks = [];
    
    for (const session of sessions) {
        if (!session.candidateId || !session.authToken) continue;

        for (const job of jobs) {
            if (!job.jobId || !job.scheduleId) continue;

            allTasks.push({
                jobId: job.jobId,
                scheduleId: job.scheduleId,
                candidateId: session.candidateId,
                authToken: session.authToken,
                cookieHeader: session.cookieHeader || ""
            });
        }
    }

    // --- 4. DISTRIBUTE TO WORKERS ---
    if (allTasks.length > 0) {
        // Push to Redis. All instances (including this one) will start grabbing tasks.
        await jobQueue.addTasks(allTasks);
        
        console.log(`[Manager] Distributed ${allTasks.length} tasks.`);

        res.json({ 
            status: 'aws_batch_started', 
            message: `Swarm started. Distributed ${allTasks.length} tasks across the grid.`,
            successful: 6, // Number of instances (static for now)
            details: {
                accounts: sessions.length,
                jobs: jobs.length,
                totalTasks: allTasks.length
            }
        });
    } else {
        res.status(400).json({ status: 'failed', message: "No valid tasks could be generated." });
    }
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

// Error Handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('🔥 Unhandled Error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
});

// --- SETUP & START ---
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    await jobQueue.connect(); 
    
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
