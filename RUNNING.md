# Application Running Guide

## ✅ Backend Server
- **Status**: Running
- **URL**: http://localhost:3000
- **API Endpoints**:
  - POST http://localhost:3000/api/register (Google Form integration)
  - GET/POST http://localhost:3000/api/webhook (WhatsApp webhook)
  - GET http://localhost:3000/api/users (Admin - get all users)
  - PATCH http://localhost:3000/api/users/:id (Admin - update user)
  - GET http://localhost:3000/api/logs (Admin - get logs)

## ✅ Frontend Admin UI
- **Status**: Running
- **URL**: http://localhost:5173
- **Pages**:
  - Dashboard: http://localhost:5173/
  - Users: http://localhost:5173/users
  - Logs: http://localhost:5173/logs

## 🔧 Configuration
- Backend env file: `backend/.env`
- You need to add:
  - OPENAI_API_KEY
  - WHATSAPP_TOKEN
  - WHATSAPP_PHONE_NUMBER_ID
  - VERIFY_TOKEN
  - MONGO_URI (currently using local: mongodb://localhost:27017/english-lesson-automation)

## 📝 Next Steps
1. Update `backend/.env` with your actual API keys
2. Set up WhatsApp webhook in Meta Developer Console pointing to: http://YOUR_DOMAIN/api/webhook
3. Add Google Apps Script to your Google Form (see backend/README.md)
4. Test registration by submitting the Google Form
5. Monitor users and logs via Admin UI at http://localhost:5173

## 🔄 Cron Jobs
- Daily lesson: 7:00 AM IST (generates and sends lessons)
- State reset: 12:00 AM IST (resets COMPLETED_TODAY to READY)

## 🛑 To Stop Servers
- Backend: Find the terminal running `node server.js` and press Ctrl+C
- Frontend: Find the terminal running `npm run dev` and press Ctrl+C
