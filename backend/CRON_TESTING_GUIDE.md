# 🧪 Cron Job Manual Testing Guide

## Base URL
```
http://localhost:3001
```

---

## 📋 Available Cron Job Test Endpoints

### 1. ☀️ **Daily Lesson Generation** (7 AM Cron)

**Endpoint:**
```
GET  http://localhost:3001/api/cron/trigger-daily-lesson
POST http://localhost:3001/api/cron/trigger-daily-lesson
```

**What it does:**
- Finds all active users with `state=READY`
- Fetches curriculum topic for user's level + day
- Generates structured JSON lesson with AI (gpt-4o-mini)
- Saves lesson to Lessons collection
- Updates TutorMemory
- Sends WhatsApp notification template
- Sets user state to `WAITING_START`

**Schedule:** Daily at 7:00 AM IST

**Test in Postman:**
- Method: `GET` or `POST`
- URL: `http://localhost:3001/api/cron/trigger-daily-lesson`
- Body: None required

**Expected Response:**
```json
{
  "success": true,
  "message": "Daily lesson cron triggered successfully",
  "totalUsers": 2,
  "results": [
    {
      "success": true,
      "user": "John Doe",
      "phone": "919876543210",
      "day": 5
    }
  ]
}
```

---

### 2. 🌙 **Midnight State Reset** (12:00 AM Cron)

**Endpoint:**
```
POST http://localhost:3001/api/cron/trigger-midnight-reset
```

**What it does:**
- Resets all users with `state=COMPLETED_TODAY` to `state=READY`
- Resets `lessonCompleted` flag to false

**Schedule:** Daily at 12:00 AM IST

**Test in Postman:**
- Method: `POST`
- URL: `http://localhost:3001/api/cron/trigger-midnight-reset`
- Body: None required

**Expected Response:**
```json
{
  "success": true,
  "message": "Midnight reset triggered successfully",
  "usersReset": 5
}
```

---

### 3. ⏰ **Expiry Reminder** (9 AM Cron)

**Endpoint:**
```
POST http://localhost:3001/api/cron/trigger-expiry-reminder
```

**What it does:**
- Sends 7-day reminder to users expiring in 7 days
- Sends 3-day reminder to users expiring in 3 days
- Uses WhatsApp templates: `expiry_reminder_7_days_new` and `expiry_reminder_3_days_new`

**Schedule:** Daily at 9:00 AM IST

**Test in Postman:**
- Method: `POST`
- URL: `http://localhost:3001/api/cron/trigger-expiry-reminder`
- Body: None required

**Expected Response:**
```json
{
  "success": true,
  "message": "Expiry reminder cron triggered successfully",
  "sevenDayReminders": 3,
  "threeDayReminders": 2,
  "totalReminders": 5
}
```

---

### 4. 🔥 **Streak Reset** (12:10 AM Cron)

**Endpoint:**
```
POST http://localhost:3001/api/cron/trigger-streak-reset
```

**What it does:**
- Finds users who missed lessons (gap > 1 day)
- Resets their streak to 0
- Logs streak reset events

**Schedule:** Daily at 12:10 AM IST (10 minutes after midnight)

**Test in Postman:**
- Method: `POST`
- URL: `http://localhost:3001/api/cron/trigger-streak-reset`
- Body: None required

**Expected Response:**
```json
{
  "success": true,
  "message": "Streak reset cron triggered successfully",
  "streaksReset": 2,
  "totalUsers": 50
}
```

---

### 5. 📊 **Weekly Performance Summary** (Sunday 6 PM Cron)

**Endpoint:**
```
POST http://localhost:3001/api/cron/trigger-weekly-summary
```

**What it does:**
- Sends weekly performance report via WhatsApp
- Template: `weekly_summary_new`
- Includes: Name, lessons completed this week, current streak
- Resets `weeklyCompletedCount` to 0 after sending

**Schedule:** Every Sunday at 6:00 PM IST

**Test in Postman:**
- Method: `POST`
- URL: `http://localhost:3001/api/cron/trigger-weekly-summary`
- Body: None required

**Expected Response:**
```json
{
  "success": true,
  "message": "Weekly summary cron triggered successfully",
  "summariesSent": 45,
  "totalActiveUsers": 50
}
```

---

### 6. ⏹️ **Subscription Expiry Check** (12:00 AM Cron)

**Status:** ⚠️ **NOT YET EXPOSED AS API ENDPOINT**

**What it does:**
- Deactivates users whose `expiryDate` < today
- Sets `isActive = false`
- Stops daily lesson delivery

**Schedule:** Daily at 12:00 AM IST

**To test:** Need to add endpoint to `cronRoutes.js` (see section below)

---

## 🔧 Testing Workflow

### **Scenario 1: Test Complete Daily Flow**

1. **Midnight (Day Change):**
   ```
   POST http://localhost:3001/api/cron/trigger-midnight-reset
   ```

2. **12:10 AM (Streak Check):**
   ```
   POST http://localhost:3001/api/cron/trigger-streak-reset
   ```

3. **7:00 AM (Lesson Generation):**
   ```
   GET http://localhost:3001/api/cron/trigger-daily-lesson
   ```

4. **9:00 AM (Expiry Reminders):**
   ```
   POST http://localhost:3001/api/cron/trigger-expiry-reminder
   ```

5. **User Actions (WhatsApp):**
   - User: `START` → Receives lesson
   - User: `DONE` → Updates streak

### **Scenario 2: Test Weekly Summary**

```
POST http://localhost:3001/api/cron/trigger-weekly-summary
```

Run on Sunday after users have completed lessons throughout the week.

---

## 📝 Postman Collection Setup

### Import these as Postman Collection:

1. **Create new collection:** "Cron Jobs Testing"

2. **Add requests:**

**Request 1: Daily Lesson**
- Name: `Daily Lesson (7AM)`
- Method: `GET`
- URL: `{{base_url}}/api/cron/trigger-daily-lesson`

**Request 2: Midnight Reset**
- Name: `Midnight Reset (12AM)`
- Method: `POST`
- URL: `{{base_url}}/api/cron/trigger-midnight-reset`

**Request 3: Expiry Reminder**
- Name: `Expiry Reminder (9AM)`
- Method: `POST`
- URL: `{{base_url}}/api/cron/trigger-expiry-reminder`

**Request 4: Streak Reset**
- Name: `Streak Reset (12:10AM)`
- Method: `POST`
- URL: `{{base_url}}/api/cron/trigger-streak-reset`

**Request 5: Weekly Summary**
- Name: `Weekly Summary (Sunday 6PM)`
- Method: `POST`
- URL: `{{base_url}}/api/cron/trigger-weekly-summary`

3. **Set environment variable:**
   - Variable: `base_url`
   - Value: `http://localhost:3001`

---

## ⚠️ Important Notes

### Prerequisites for Testing:

1. **Backend server must be running:**
   ```bash
   cd ImproveEnglish/backend
   node server.js
   ```

2. **MongoDB must be connected**

3. **Environment variables must be set:**
   - `OPENAI_API_KEY` (for lesson generation)
   - `WHATSAPP_TOKEN` (for message sending)
   - `WHATSAPP_PHONE_NUMBER_ID`

4. **For Daily Lesson to work:**
   - Must have `curriculum_topics` collection populated
   - Users must exist with `isActive=true` and `state=READY`

5. **For Expiry Reminders to work:**
   - Users must have `expiryDate` set
   - Templates `expiry_reminder_7_days_new` and `expiry_reminder_3_days_new` must be approved

6. **For Weekly Summary to work:**
   - Template `weekly_summary_new` must be approved
   - Users must have `weeklyCompletedCount > 0`

### Expected Behavior:

✅ **Success:** Returns JSON with success=true and details
❌ **Error:** Returns JSON with success=false and error message
📝 **Logs:** Check MongoDB `logs` collection for detailed execution logs

### Common Issues:

1. **"No curriculum topic found"**
   - Solution: Populate `curriculum_topics` collection with topics for the user's current day + level

2. **"WhatsApp template not found"**
   - Solution: Ensure templates are approved in Meta Business Manager

3. **"No users found"**
   - Solution: Check that users exist with correct `isActive`, `state`, and `expiryDate` values

---

## 🗂️ Cron Job Files Location

All cron job files are located at:
```
/backend/cron/
├── dailyLesson.js          ✅ Has API endpoint
├── resetState.js           ⚠️ DISABLED (not needed)
├── subscriptionExpiry.js   ⚠️ No API endpoint yet
├── expiryReminder.js       ✅ Has API endpoint
├── streakReset.js          ✅ Has API endpoint
└── weeklySummary.js        ✅ Has API endpoint
```

Manual trigger routes are defined in:
```
/backend/routes/cronRoutes.js
```

---

## 🚀 Quick Test Commands (cURL)

If you prefer terminal over Postman:

```bash
# Daily Lesson
curl -X GET http://localhost:3001/api/cron/trigger-daily-lesson

# Midnight Reset
curl -X POST http://localhost:3001/api/cron/trigger-midnight-reset

# Expiry Reminder
curl -X POST http://localhost:3001/api/cron/trigger-expiry-reminder

# Streak Reset
curl -X POST http://localhost:3001/api/cron/trigger-streak-reset

# Weekly Summary
curl -X POST http://localhost:3001/api/cron/trigger-weekly-summary
```

---

## 📊 Monitoring & Logs

### Check Logs in MongoDB:

```javascript
// All cron logs
db.logs.find({ type: /CRON/ }).sort({ createdAt: -1 }).limit(10)

// Specific cron type
db.logs.find({ type: "LESSON_GENERATED" }).sort({ createdAt: -1 })
db.logs.find({ type: "CRON_EXPIRY" }).sort({ createdAt: -1 })
db.logs.find({ type: "STREAK_RESET" }).sort({ createdAt: -1 })
```

### Check Console Output:

Watch the terminal running `node server.js` for real-time cron execution logs.

---

**Last Updated:** February 24, 2026
**System Version:** V2 (Structured Lesson Architecture)
