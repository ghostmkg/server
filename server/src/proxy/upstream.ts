// filepath: server/src/shared/upstream.ts
import { Request, Response, NextFunction } from 'express';
import { SessionStore, Cookie } from '../store/sessionStore';
import * as https from 'https';
import { URL } from 'url';

// 1. GLOBAL AGENT (CRITICAL FOR SPEED)
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: Infinity,
  maxFreeSockets: 256,
  timeout: 30000
});

function serializeCookies(cookies: Cookie[], domain: string): string {
  const relevantCookies = cookies.filter(cookie => {
    const cookieDomain = cookie.domain.replace(/^\./, '');
    const requestDomain = domain.replace(/^\./, '');
    return requestDomain.endsWith(cookieDomain) || cookieDomain === requestDomain;
  });

  const now = Math.floor(Date.now() / 1000);
  return relevantCookies
    .filter(c => !c.expires || c.expires > now)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

export function createUpstreamForwarder(sessionStore: SessionStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const candidateId = req.ctx?.candidate?.candidateId;
    if (!candidateId) {
      return res.status(400).json({ error: 'missing_context', message: 'Candidate context missing' });
    }

    try {
      const session = req.ctx!.candidate!.session;
      
      // --- CRITICAL FIX: DYNAMIC ROUTING LOGIC ---
      let targetHost = 'hiring.amazon.com'; // Default to US
      
      // 1. Check if extension explicitly requested a domain (Reliable)
      const explicitDomain = req.headers['x-target-domain'];
      if (typeof explicitDomain === 'string' && explicitDomain.includes('amazon')) {
          targetHost = explicitDomain;
      } 
      // 2. Fallback: Detect from path or host header
      else if (req.path.includes('/application/ca/') || req.headers['host']?.includes('.ca')) {
          targetHost = 'hiring.amazon.ca';
      }

      // Construct Target URL
      const targetUrl = new URL(`https://${targetHost}${req.originalUrl}`);

      // Prepare headers
      const headers: Record<string, string> = {};
      const safeHeaders = ['content-type', 'accept', 'accept-language', 'user-agent', 'x-requested-with', 'origin', 'referer'];
      
      safeHeaders.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h] as string;
      });

      // Inject Auth & Cookies
      if (session.accessToken) headers['Authorization'] = session.accessToken;
      if (session.cookies) headers['Cookie'] = serializeCookies(session.cookies, targetHost);
      if (session.csrf) headers['X-Csrf-Token'] = session.csrf;

      const options: https.RequestOptions = {
        hostname: targetUrl.hostname,
        port: 443,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: headers,
        agent: httpsAgent,
        timeout: 15000
      };

      await new Promise<void>((resolve) => {
        const upstreamReq = https.request(options, (upstreamRes) => {
          if (upstreamRes.statusCode === 429) {
            console.warn(`[${candidateId}] Upstream 429 Rate Limit`);
            if (!res.headersSent) {
              res.status(429).json({
                error: 'upstream_rate_limit',
                message: 'Amazon upstream rate limited',
                retryAfter: upstreamRes.headers['retry-after'] || '5'
              });
            }
            upstreamRes.resume();
            resolve();
            return;
          }

          res.status(upstreamRes.statusCode || 502);
          Object.keys(upstreamRes.headers).forEach(key => {
            if (upstreamRes.headers[key]) res.setHeader(key, upstreamRes.headers[key] as string | string[]);
          });

          upstreamRes.pipe(res);
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', () => resolve());
        });

        upstreamReq.on('error', (err: any) => {
          console.error(`[${candidateId}] Connection Error to ${targetHost}:`, err.message);
          if (!res.headersSent) res.status(502).json({ error: 'upstream_failed', message: err.message });
          resolve();
        });

        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
            if (!res.headersSent) res.status(504).json({ error: 'timeout' });
            resolve();
        });

        if (req.body) {
           const bodyData = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
           upstreamReq.write(bodyData);
        }
        upstreamReq.end();
      });

    } catch (error: any) {
      console.error(`[${candidateId}] Critical Forwarder Error:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  };
}