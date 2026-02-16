# WhatsApp Template Message Setup

## Overview
WhatsApp Business API requires using **approved templates** for business-initiated messages (messages you send first to users). This is a Meta policy requirement.

## Template Configuration Required

### Template Name: `daily_english_lesson`

### Template Category: `UTILITY`

### Template Language: `English (US)`

### Template Content:

```
Hello {{1}}.

This is your scheduled English lesson for Day {{2}}.

Reply START to receive today's lesson.

Please confirm completion.
```

### Parameters:
- `{{1}}` = User's name (e.g., "Rajesh Hirulkar")
- `{{2}}` = Day number (e.g., "8")

---

## How to Create Template in Meta Dashboard

### Step 1: Go to WhatsApp Business Manager
1. Visit: https://business.facebook.com/
2. Select your Business Account
3. Click **WhatsApp Manager** in left sidebar

### Step 2: Create Message Template
1. Click **Message Templates** (left sidebar)
2. Click **Create Template** button
3. Fill in details:
   - **Template name:** `daily_english_lesson`
   - **Category:** `UTILITY`
   - **Languages:** Select `English (US)`

### Step 3: Add Template Body
1. In the **Body** section, paste this exact text:

```
Hello {{1}}.

This is your scheduled English lesson for Day {{2}}.

Reply START to receive today's lesson.

Please confirm completion.
```

2. Click **+ Add Variable** twice to add `{{1}}` and `{{2}}`
3. Set variable 1 sample: `John`
4. Set variable 2 sample: `1`

### Step 4: Submit for Review
1. Review the template
2. Click **Submit**
3. Wait for Meta approval (usually 15 minutes to 24 hours)

### Step 5: Check Status
- Status will show as **PENDING** → **APPROVED**
- Once approved, your cron job will be able to send template messages

---

## Example Template Message

When a user receives the template, they'll see:

```
Hello Rajesh Hirulkar.

This is your scheduled English lesson for Day 8.

Reply START to receive today's lesson.

Please confirm completion.
```

When they reply "START", they'll receive the full AI-generated lesson text.

---

## Template Parameters in Code

The cron job sends parameters like this:

```javascript
await sendTemplateMessage(
  user.phone, 
  'daily_english_lesson', 
  [user.name, user.currentDay.toString()]
);
```

- Parameter 1: User name
- Parameter 2: Day number (converted to string)

---

## Why Template Messages?

WhatsApp Business API has strict rules:
- ✅ **Business-initiated messages** (you message first) must use approved templates
- ✅ **User-initiated messages** (24-hour window after user responds) can be free text
- ❌ Cannot send free text to users who haven't messaged you first

That's why we:
1. Send **template** at 7am (business-initiated)
2. User replies "START" (opens 24-hour window)
3. Send **free text** lesson (within 24-hour window)

---

## Testing Template

After approval, test manually:

```bash
curl -X POST http://localhost:3000/api/test-template \
  -H "Content-Type: application/json" \
  -d '{"phone":"919096994914","name":"Rajesh","day":8}'
```

Or wait for the 7am cron job to run automatically!

---

## Troubleshooting

### Template Not Found Error
- Ensure template name is exactly: `daily_english_lesson`
- Check template status is **APPROVED** in Meta dashboard

### Template Rejected
- Remove promotional language
- Avoid URLs or links
- Keep it simple and transactional
- Use UTILITY category (not MARKETING)

### Parameters Not Working
- Ensure you're passing parameters as array of strings
- Parameter count must match template variables

---

## Current System Status

✅ Template name configured in code: `daily_english_lesson`
✅ Parameters configured: `[name, day]`
✅ Cron job scheduled: 7:00 AM IST daily
✅ Sends to all users with state: `READY`

**Next:** Create and approve the template in Meta dashboard!
