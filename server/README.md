# Amazon Hiring Proxy Server

Proxy server for Amazon Hiring API with session management, rate limiting, and candidate rotation.

## Features

- **Per-candidate session isolation**: Store sessions in Redis with cookie jars
- **Rate limiting**: Per-candidate (9 rps) and global (40 rps) token bucket rate limiting
- **429 handling**: Automatic candidate rotation on rate limits with exponential backoff
- **SSE updates**: Real-time session state updates via Server-Sent Events
- **Cookie jar management**: Automatic cookie expiration and domain matching

## Quick Start

### Using Docker Compose (Recommended)

```bash
docker compose up -d
```

This starts:
- Redis on port 6379
- Proxy server on port 8080

### Manual Setup

1. **Install dependencies:**
   ```bash
   cd server
   npm install
   ```

2. **Start Redis:**
   ```bash
   redis-server
   ```

3. **Build and run:**
   ```bash
   npm run build
   npm start
   ```

## Environment Variables

- `REDIS_URL`: Redis connection URL (default: `redis://localhost:6379`)
- `PORT`: Server port (default: `8080`)
- `PER_ID_RPS`: Per-candidate rate limit RPS (default: `9`)
- `PER_ID_BURST`: Per-candidate burst size (default: `18`)
- `GLOBAL_RPS`: Global rate limit RPS (default: `40`)
- `GLOBAL_BURST`: Global burst size (default: `80`)

## API Endpoints

### Session Management

- `POST /bootstrap` - Register a candidate session
  ```json
  {
    "candidateId": "string",
    "accessToken": "string",
    "cookies": [...],
    "csrf": "optional"
  }
  ```

- `GET /sessions` - List all registered sessions
  Returns: `Array<SessionSummary>`

- `GET /sessions/events` - SSE stream for session updates
  Events: `session:upsert`, `session:expire`, `session:pause`, `session:resume`

### Proxy Routes

- `ALL /application/*` - Proxy to `hiring.amazon.{com|ca}/application/*`
- `ALL /candidate-application/*` - Proxy to `hiring.amazon.{com|ca}/candidate-application/*`
- `ALL /api/*` - Proxy to `hiring.amazon.{com|ca}/api/*`

All proxy routes require:
- `candidate_id` in body, `x-candidate-id` header, or `candidate_id` query param
- Rate limiting is enforced before upstream calls

### Health & Metrics

- `GET /healthz` - Health check
- `GET /metrics` - Basic metrics (session counts)

## How It Works

1. **Session Storage**: Each candidate session is stored in Redis with cookies, auth token, and expiration.
2. **Request Flow**:
   - Extension sends request to proxy with `candidate_id`
   - Proxy loads session from Redis
   - Proxy injects cookies and auth from jar
   - Proxy forwards to Amazon API with unchanged URL/method/payload
   - On 429, candidate is paused with exponential backoff
3. **Rotation**: Extension selects next active (non-paused) candidate round-robin style
4. **Rate Limiting**: Token bucket algorithm prevents exceeding per-ID and global limits

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run tests (when implemented)
npm test
```

## Notes

- Upstream API calls maintain exact URL, method, payload, and headers (except Cookie/Authorization)
- Cookie expiration is automatically handled
- Session expiry is checked on read
- SSE connection auto-reconnects on error


