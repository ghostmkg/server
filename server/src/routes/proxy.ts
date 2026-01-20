// filepath: server/src/routes/proxy.ts
import { Router, Request, Response, NextFunction } from 'express';
import { createCandidateContextMiddleware } from '../mw/candidateContext';
import { createUpstreamForwarder } from '../proxy/upstream'; // Updated path
import { RateLimiter } from '../rate/limiter';
import { SessionStore } from '../store/sessionStore';

export function createProxyRouter(
  sessionStore: SessionStore,
  rateLimiter: RateLimiter
): Router {
  const router = Router();
  
  const candidateContext = createCandidateContextMiddleware(sessionStore);
  const forwardWithJar = createUpstreamForwarder(sessionStore);

  // Rate limit middleware
  const rateLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const candidateId = req.ctx?.candidate?.candidateId;
    if (!candidateId) return next();

    // Check per-ID rate limit
    const perIdResult = await rateLimiter.take(candidateId);
    if (!perIdResult.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfter: perIdResult.retryAfterMs
      });
    }

    // Check global rate limit
    const globalResult = await rateLimiter.takeGlobal();
    if (!globalResult.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Global limit',
        retryAfter: globalResult.retryAfterMs
      });
    }
    next();
  };

  // --- MANUAL VALIDATION ---
  
  const validateCreateApp = (req: Request, res: Response, next: NextFunction) => {
      // Debug log to see which worker is active
      const workerId = req.headers['x-worker-id'] || 'unknown';
      console.log(`📝 Create App | Worker: ${workerId} | Job: ${req.body?.jobId}`); 
      
      const errors = [];
      if (!req.body?.jobId) errors.push({ param: 'jobId', msg: 'Job ID is required' });
      if (!req.body?.scheduleId) errors.push({ param: 'scheduleId', msg: 'Schedule ID is required' });

      if (errors.length > 0) return res.status(400).json({ errors });
      next();
  };

  const validateUpdateApp = (req: Request, res: Response, next: NextFunction) => {
      const errors = [];
      if (!req.body?.applicationId) errors.push({ param: 'applicationId', msg: 'Application ID is required' });
      
      const payload = req.body?.payload || {};
      if (!payload.jobId) errors.push({ param: 'payload.jobId', msg: 'Job ID is required' });
      if (!payload.scheduleId) errors.push({ param: 'payload.scheduleId', msg: 'Schedule ID is required' });

      if (errors.length > 0) return res.status(400).json({ errors });
      next();
  };

  router.post('/application/api/candidate-application/ds/create-application', validateCreateApp, candidateContext, rateLimitMiddleware, forwardWithJar);
  router.put('/application/api/candidate-application/update-application', validateUpdateApp, candidateContext, rateLimitMiddleware, forwardWithJar);
  
  // Catch-all
  router.all('/application/api/*', candidateContext, rateLimitMiddleware, forwardWithJar);

  return router;
}