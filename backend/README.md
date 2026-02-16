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
3. `npm install`
4. `npm start`

## How to Deploy
- Use any Node.js host (Render, Railway, Heroku, etc.)
- Set all env vars from `.env.example`
- Ensure MongoDB and WhatsApp Cloud API access

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
