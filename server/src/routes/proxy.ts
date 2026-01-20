// filepath: server/src/routes/proxy.ts
import { Router, Request, Response, NextFunction } from 'express';
import { createCandidateContextMiddleware } from '../mw/candidateContext';
import { createUpstreamForwarder } from '../proxy/upstream';
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
        message: 'Per-candidate rate limit exceeded',
        retryAfter: perIdResult.retryAfterMs
      });
    }

    // Check global rate limit
    const globalResult = await rateLimiter.takeGlobal();
    if (!globalResult.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Global rate limit exceeded',
        retryAfter: globalResult.retryAfterMs
      });
    }
    next();
  };

  // --- MANUAL VALIDATION (No Library Required) ---
  
  router.post(
    '/application/api/candidate-application/ds/create-application',
    (req: Request, res: Response, next: NextFunction) => {
      console.log('📝 Create App Request (New Code Loaded)'); // Debug log
      
      const errors = [];
      if (!req.body?.jobId) errors.push({ param: 'jobId', msg: 'Job ID is required' });
      if (!req.body?.scheduleId) errors.push({ param: 'scheduleId', msg: 'Schedule ID is required' });

      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }
      next();
    },
    candidateContext,
    rateLimitMiddleware,
    forwardWithJar
  );

  router.put(
    '/application/api/candidate-application/update-application',
    (req: Request, res: Response, next: NextFunction) => {
      const errors = [];
      if (!req.body?.applicationId) errors.push({ param: 'applicationId', msg: 'Application ID is required' });
      
      // Handle nested payload safely
      const payload = req.body?.payload || {};
      if (!payload.jobId) errors.push({ param: 'payload.jobId', msg: 'Job ID is required' });
      if (!payload.scheduleId) errors.push({ param: 'payload.scheduleId', msg: 'Schedule ID is required' });

      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }
      next();
    },
    candidateContext,
    rateLimitMiddleware,
    forwardWithJar
  );

  // Catch-all
  router.all('/application/api/*', candidateContext, rateLimitMiddleware, forwardWithJar);

  return router;
}