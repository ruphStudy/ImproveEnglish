# WhatsApp Template Setup Instructions

## Templates to Create in Meta Business Manager

Go to: https://business.facebook.com/wa/manage/message-templates/

---

## Template 1: expiry_reminder_7_days

**Template Name:** `expiry_reminder_7_days`  
**Category:** UTILITY  
**Language:** English (US) - `en_US`

**Body Text:**
```
Hi {{1}},

Your English learning plan will expire in 7 days.

Continue your fluency journey without interruption.

Reply UPGRADE anytime to extend your plan.
```

**Variables:**
- {{1}} = User's name

---

## Template 2: expiry_reminder_3_days

**Template Name:** `expiry_reminder_3_days`  
**Category:** UTILITY  
**Language:** English (US) - `en_US`

**Body Text:**
```
Hi {{1}},

Your English learning plan will expire in 3 days.

Upgrade now to avoid losing your streak and progress.

Reply UPGRADE to continue.
```

**Variables:**
- {{1}} = User's name

---

## Template 3: weekly_summary

**Template Name:** `weekly_summary`  
**Category:** UTILITY  
**Language:** English (US) - `en_US`

**Body Text:**
```
📊 Weekly Summary

Hi {{1}},

Lessons Completed This Week: {{2}}
Current Streak: {{3}} 🔥

Keep going! You're building a powerful English habit.
```

**Variables:**
- {{1}} = User's name
- {{2}} = Weekly lessons completed count
- {{3}} = Current streak

---

## Approval Process

1. Log into Meta Business Manager
2. Navigate to WhatsApp > Message Templates
3. Click "+ Create Template"
4. Enter template name exactly as shown above
5. Select "UTILITY" as category
6. Select "English (US)" as language
7. Copy/paste the body text (including {{1}} placeholder)
8. Submit for approval
9. Wait 24-48 hours for approval

## Testing After Approval

Once templates are approved, test using Postman:

**Expiry Reminders:**
`POST http://localhost:3001/api/cron/trigger-expiry-reminder`

This will manually trigger the expiry reminder system and send messages to users who:
- Are 7 days from expiry (and haven't received 7-day reminder)
- Are 3 days from expiry (and haven't received 3-day reminder)

**Weekly Summary:**
`POST http://localhost:3001/api/cron/trigger-weekly-summary`

This will manually send weekly performance summaries to all active users and reset their weekly counters.

## Code Implementation

The code is already implemented and will use:
- Template: `expiry_reminder_7_days` with user's name as parameter
- Template: `expiry_reminder_3_days` with user's name as parameter
- Template: `weekly_summary` with name, weekly count, and streak as parameters
- Language: `en_US`

See: 
- `/backend/cron/expiryReminder.js`
- `/backend/cron/weeklySummary.js`
