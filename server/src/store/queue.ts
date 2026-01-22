// filepath: server/src/store/queue.ts
import { createClient } from 'redis';

export class JobQueue {
  private publisher;
  private subscriber;
  private client;
  private isConnected = false;

  constructor(private redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();
  }

  async connect() {
    try {
        await this.client.connect();
        await this.publisher.connect();
        await this.subscriber.connect();
        this.isConnected = true;
        console.log('✅ Queue System Connected');
    } catch (err) {
        console.error('❌ Redis Connection Error:', err);
    }
  }

  async disconnect() {
    if (this.isConnected) {
        await this.client.disconnect();
        await this.publisher.disconnect();
        await this.subscriber.disconnect();
        this.isConnected = false;
    }
  }

  // 1. The Manager calls this to add work
  async addTasks(tasks: any[]) {
    // Clear old queue first (optional - depends on if you want to wipe previous runs)
    await this.client.del('job_queue');
    
    // Push all tasks as strings
    for (const task of tasks) {
      await this.client.rPush('job_queue', JSON.stringify(task));
    }
    console.log(`[Queue] Added ${tasks.length} tasks to Redis`);
  }

  // 2. Workers call this to get work
  async getNextTask() {
    // Pop a task from the left (First In, First Out)
    const task = await this.client.lPop('job_queue');
    return task ? JSON.parse(task) : null;
  }

  // 3. Broadcast STOP signal
  async broadcastStop() {
    await this.publisher.publish('control_channel', 'STOP');
  }

  // 4. Listen for STOP signal
  async onStop(callback: () => void) {
    await this.subscriber.subscribe('control_channel', (message) => {
      if (message === 'STOP') {
        callback();
      }
    });
  }

  // --- NEW: LIVE LOG STREAMING ---
  // These methods allow the server to "Push" logs to the browser
  
  // 5. Workers call this to say "I did something" (Success/Error)
  async publishLog(message: string) {
    // Publish to a specific channel for logs
    if (this.isConnected) {
        await this.publisher.publish('live_logs', message);
    }
  }

  // 6. The API Server calls this to stream logs to the Browser (via SSE)
  async subscribeToLogs(callback: (msg: string) => void) {
    // We need a DEDICATED subscriber for logs to avoid blocking the main subscriber
    const logSub = this.client.duplicate();
    await logSub.connect();
    
    await logSub.subscribe('live_logs', (message) => {
      callback(message);
    });
    
    return logSub; // Return it so we can close it when the browser tab closes
  }
}