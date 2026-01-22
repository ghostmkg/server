// filepath: server/src/index.ts
import express from 'express';
import cors from 'cors';
// import fetch from 'node-fetch'; // Using native fetch in Node 18+
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
        
        // --- PHASE 1: CREATE APPLICATION (Run Once) ---
        let applicationId: string | null = null;

        // Loop only until we successfully get an Application ID
        while (this.active && !applicationId) {
            applicationId = await this.createApplication(domain);
            
            if (!applicationId) {
                // If creation failed (e.g. rate limit), wait before retrying
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // If stopped or failed to create, exit
        if (!this.active || !applicationId) return;

        console.log(`[Worker] 🔄 Entering Polling Loop for App ID: ${applicationId}`);

        // --- PHASE 2: UPDATE LOOP (Poll Only) ---
        while (this.active) {
            try {
                // ONLY Call Update Application
                const confirmed = await this.updateApplication(domain, applicationId);
                
                if (confirmed) {
                    const successMsg = `🎉 Job Confirmed! Stopping worker for ${this.candidateId.slice(0,5)}`;
                    console.log(`[Worker] ${successMsg}`);
                    jobQueue.publishLog(JSON.stringify({ type: 'success', msg: successMsg }));
                    
                    this.active = false; // STOP THE LOOP
                    return;
                }

                // Wait before next poll
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

            } catch (err) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // Helper: Create Application (Returns ID or null)
    async createApplication(domain: string): Promise<string | null> {
        try {
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
                    const msg = `✅ App Created/Found: ${appId} for ${this.candidateId.slice(0,5)}`;
                    console.log(`[Worker] ${msg}`);
                    jobQueue.publishLog(JSON.stringify({ type: 'success', msg }));
                    return appId;
                }
            } else if (createRes.status === 429) {
                console.log(`[Worker] ⚠️ Create Rate Limit (429)`);
            }
        } catch (err: any) {
            const msg = `❌ Create Error on ${this.candidateId.slice(0,5)}: ${err.message}`;
            console.error(`[Worker] ${msg}`);
            jobQueue.publishLog(JSON.stringify({ type: 'error', msg }));
        }
        return null;
    }

    // Helper: Update Application (Returns true if confirmed)
    async updateApplication(domain: string, applicationId: string): Promise<boolean> {
         try {
            const res = await fetch(`https://${domain}/application/api/candidate-application/update-application`, {
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
            
            if (res.status === 200) {
                const data: any = await res.json();
                // If no errors, we assume success
                if (!data.errors || data.errors.length === 0) {
                    return true;
                }
            }
            return false;
         } catch(e) {
            return false;
         }
    }

    stop() {
        this.active = false;
    }
}

// Local array to track what THIS specific instance is running
const localWorkers: JobWorker[] = [];

// --- CONSUMER LOOP ---
async function startTaskConsumer() {
    console.log('👀 Worker Node started. Watching queue...');
    
    setInterval(async () => {
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
    }, 1000); 
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

// --- LOG STREAM (Heartbeat) ---
app.get('/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(': connected\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

    const logSub = await jobQueue.subscribeToLogs((message) => {
        res.write(`data: ${message}\n\n`);
    });

    req.on('close', async () => {
        clearInterval(heartbeat);
        await logSub.disconnect();
    });
});

// --- API ROUTES ---

app.post('/start', async (req, res) => {
    console.log('🚀 [API] Received START command');

    // 1. INPUT NORMALIZATION
    let sessions = [];
    if (Array.isArray(req.body.sessions) && req.body.sessions.length > 0) {
        sessions = req.body.sessions; 
    } else if (req.body.candidateId && req.body.authToken) {
        sessions.push({
            candidateId: req.body.candidateId,
            authToken: req.body.authToken,
            cookieHeader: req.body.cookieHeader
        });
    }

    let jobs = [];
    if (Array.isArray(req.body.combinations) && req.body.combinations.length > 0) {
        jobs = req.body.combinations;
    } else if (req.body.jobId && req.body.scheduleId) {
        jobs.push({ jobId: req.body.jobId, scheduleId: req.body.scheduleId });
    }

    // 2. VALIDATION
    if (sessions.length === 0 || jobs.length === 0) {
        return res.status(400).json({ 
            status: 'failed', 
            message: `Invalid Input. Found ${sessions.length} accounts and ${jobs.length} jobs.` 
        });
    }

    // 3. GENERATE TASKS
    const allTasks = [];
    let skippedSessions = 0;
    
    for (const session of sessions) {
        if (!session.candidateId || !session.authToken) {
            skippedSessions++;
            continue;
        }

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

    // 4. DISTRIBUTE
    if (allTasks.length > 0) {
        await jobQueue.addTasks(allTasks);
        console.log(`[Manager] Distributed ${allTasks.length} tasks.`);
        res.json({ 
            status: 'aws_batch_started', 
            message: `Swarm started. Distributed ${allTasks.length} tasks.`,
            successful: 6,
            details: { accounts: sessions.length, jobs: jobs.length, totalTasks: allTasks.length }
        });
    } else {
        res.status(400).json({ status: 'failed', message: `No valid tasks generated. Skipped ${skippedSessions} invalid sessions.` });
    }
});

app.post('/stop', async (req, res) => {
    console.log('🛑 [API] Received STOP command');
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

// --- START ---
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    await jobQueue.connect(); 
    
    startTaskConsumer();

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
