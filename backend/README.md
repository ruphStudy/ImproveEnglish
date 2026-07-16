# WhatsApp English Lesson Automation Backend

## Features
- User registration via Google Form (POST /api/register)
- Daily English lessons sent via WhatsApp Cloud API
- OpenAI-powered lesson generation
- Admin API for users/logs
- Cron jobs for daily lesson and state reset
- Centralized error logging
- Security: helmet, rate limit, env vars

## Folder Structure
- server.js
- config/
- models/
- routes/
- controllers/
- services/
- cron/
- middleware/
- utils/

## How to Run Locally
1. Clone repo & `cd backend`
2. `cp .env.example .env` and fill secrets
3. **Install and start Redis** (required for queue system):
   ```bash
   # macOS (using Homebrew)
   brew install redis
   brew services start redis
   
   # Ubuntu/Debian
   sudo apt-get install redis-server
   sudo systemctl start redis
   
   # Windows (using WSL or Docker)
   docker run -d -p 6379:6379 redis:latest
   ```
4. Verify Redis is running:
   ```bash
   redis-cli ping
   # Should return: PONG
   ```
5. `npm install`
6. `npm start`

## Redis & Queue System

### Why Redis?
The app uses **Bull Queue** with Redis for parallel processing of daily lessons. This enables:
- **Performance**: 1000 users processed in ~23 minutes (vs 5.8 hours sequentially)
- **Scalability**: Handles 10k+ users with same architecture
- **Reliability**: Job retries, failure tracking, and monitoring

### Queue Configuration
- **Workers**: 15 parallel workers by default (configurable via `LESSON_WORKER_CONCURRENCY`)
- **Retry Strategy**: 3 attempts with exponential backoff (5s, 25s, 125s)
- **Job Retention**: Keeps last 100 completed jobs, 200 failed jobs for debugging
- **Processing Time**: ~21 seconds per lesson (AI generation bottleneck)

### Queue Monitoring Endpoints
Monitor queue health in production:

1. **Get Queue Stats**: `GET /api/cron/queue/stats`
   ```json
   {
     "stats": {
       "waiting": 50,
       "active": 15,
       "completed": 935,
       "failed": 2,
       "total": 65
     }
   }
   ```

2. **Get Recent Jobs**: `GET /api/cron/queue/jobs?status=completed&limit=20`
   - Query params: `status` (completed/failed/waiting/active), `limit` (max 100)
   - Returns job details with timestamps and results

3. **Clean Old Jobs**: `POST /api/cron/queue/clean`
   - Body: `{ "grace": 3600000 }` (milliseconds, default 1 hour)
   - Removes completed/failed jobs older than grace period

### Manual Testing
Trigger queue manually for testing:
```bash
# Enqueue all READY users (non-blocking)
curl -X POST http://localhost:3001/api/cron/trigger-daily-lesson

# Check queue stats
curl http://localhost:3001/api/cron/queue/stats

# View recent completed jobs
curl http://localhost:3001/api/cron/queue/jobs?status=completed&limit=10
```

### Redis Connection Configuration
Set these in `.env`:
```
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=          # Leave empty for local, set for production
LESSON_WORKER_CONCURRENCY=15
```

### Troubleshooting Redis
- **Connection refused**: Ensure Redis is running (`redis-cli ping`)
- **Port conflict**: Change `REDIS_PORT` if 6379 is taken
- **Performance issues**: Increase `LESSON_WORKER_CONCURRENCY` (but watch OpenAI rate limits)
- **Memory issues**: Lower concurrency or clean old jobs more frequently

## How to Deploy
- Use any Node.js host (Render, Railway, Heroku, etc.)
- **Redis requirement**: Must have Redis instance accessible
  - **Render**: Add Redis service from dashboard, connect via internal URL
  - **Railway**: Add Redis plugin, connection URL auto-configured
  - **Heroku**: Add Heroku Redis addon
  - **AWS/Azure/GCP**: Use managed Redis (ElastiCache, Azure Cache, Memorystore)
  - **Redis Cloud**: Free tier available at [redis.com](https://redis.com)
- Set all env vars from `.env.example` (including Redis connection)
- Ensure MongoDB and WhatsApp Cloud API access
- Workers start automatically on server startup

## Google Form Integration
- Use Google Apps Script to POST form data to `/api/register`
- See `google-apps-script.js` for complete setup instructions
- Example workflow:
  1. User fills Google Form with Name and Phone
  2. Form submits and triggers Google Apps Script
  3. Script sends POST request to `/api/register` with `{name, phone}`
  4. Backend creates/updates user in MongoDB with state='READY'
  5. User is now registered and will receive daily lessons at 7 AM IST

## WhatsApp Webhook Verification
- Set webhook URL in Meta dashboard to `/api/webhook`
- Use GET `/api/webhook?hub.mode=subscribe&hub.verify_token=YOURTOKEN&hub.challenge=1234` to verify
- Use POST `/api/webhook` for WhatsApp events

## API Endpoints
- `POST /api/register` — Register user
- `GET /api/users` — List users
- `PATCH /api/users/:id` — Update user state
- `GET /api/logs` — List logs
- `GET/POST /api/webhook` — WhatsApp webhook

## Environment Variables
See `.env.example` for required keys.

## Notes
- WhatsApp template name must match your Meta setup (see `sendTemplateMessage`)
- All times are Asia/Kolkata (IST)
- No user-facing UI in backend
