import { Request, Response, NextFunction } from 'express';
import { SessionStore } from '../store/sessionStore';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      ctx?: {
        candidate?: {
          candidateId: string;
          session: any;
        };
      };
    }
  }
}

export function createCandidateContextMiddleware(sessionStore: SessionStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let candidateId: string | null = null;

      // Try to extract from JSON body
      if (req.body && typeof req.body === 'object') {
        candidateId = req.body.candidate_id || req.body.candidateId || null;
      }

      // Fallback to header
      if (!candidateId) {
        candidateId = req.headers['x-candidate-id'] as string || null;
      }

      // Fallback to query parameter
      if (!candidateId) {
        candidateId = req.query.candidate_id as string || req.query.candidateId as string || null;
      }

      if (!candidateId) {
        return res.status(400).json({ error: 'unknown_candidate', message: 'candidate_id not provided' });
      }

      // Load session
      const session = await sessionStore.getCandidateSession(candidateId);
      
      if (!session) {
        return res.status(400).json({ error: 'unknown_candidate', message: `No session found for candidate ${candidateId}` });
      }

      // Attach to request context
      if (!req.ctx) {
        req.ctx = {};
      }
      
      req.ctx.candidate = {
        candidateId,
        session
      };

      next();
    } catch (error) {
      console.error('Candidate context middleware error:', error);
      res.status(500).json({ error: 'internal_error', message: 'Failed to load candidate context' });
    }
  };
}


