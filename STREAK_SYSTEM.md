# Streak System Documentation

## Overview
The streak system tracks consecutive days of lesson completion to encourage daily engagement and build learning habits.

## How It Works

### Streak Increment Rules

1. **First Completion**: When a user completes their first lesson via "DONE" command, streak starts at 1.

2. **Consecutive Days**: If a user completes today's lesson and their last completion was yesterday, streak increases by 1.

3. **Missed Days**: If a user completes today's lesson but their last completion was 2+ days ago, streak resets to 1.

4. **Same Day**: If a user sends "DONE" multiple times on the same day, streak doesn't change (prevents double increment).

### Streak Reset

- **Automatic Reset**: A cron job runs at 00:10 AM IST daily
- Checks all active users
- If a user hasn't completed a lesson in 2+ days and has a non-zero streak, it resets to 0
- Logs the reset with details

## Database Schema

### User Model Fields

```javascript
streak: {
  type: Number,
  default: 0
}

lastLessonCompletedDate: {
  type: Date,
  default: null
}
```

## API Endpoints

### Get User Streak
```
GET /api/users/phone/:phone
```

**Response:**
```json
{
  "name": "John Doe",
  "phone": "919876543210",
  "email": "john@example.com",
  "level": "beginner",
  "currentDay": 15,
  "streak": 7,
  "lastLessonCompletedDate": "2026-02-23T00:00:00.000Z",
  "isActive": true,
  "state": "READY",
  "expiryDate": "2026-03-25T00:00:00.000Z",
  "lessonCompleted": true,
  "createdAt": "2026-01-20T10:30:00.000Z"
}
```

### Manual Streak Reset Trigger (Testing)
```
POST /api/cron/trigger-streak-reset
```

**Response:**
```json
{
  "success": true,
  "message": "Streak reset cron triggered successfully",
  "totalChecked": 50,
  "streaksReset": 3
}
```

## Cron Jobs

### Streak Reset Cron
- **Schedule**: Daily at 00:10 AM IST
- **Purpose**: Reset streaks for users who missed lessons
- **File**: `/backend/cron/streakReset.js`
- **Logs**: Type `STREAK_RESET` and `CRON_STREAK_RESET`

## User Flow Examples

### Example 1: Building a Streak
```
Day 1: User sends DONE → streak = 1
Day 2: User sends DONE → streak = 2
Day 3: User sends DONE → streak = 3
Day 4: User sends DONE → streak = 4
```

### Example 2: Same Day Multiple DONE
```
Day 1: User sends DONE at 8 AM → streak = 1
Day 1: User sends DONE at 5 PM → streak = 1 (no change)
Day 2: User sends DONE → streak = 2
```

### Example 3: Missed Day Reset
```
Day 1: User sends DONE → streak = 5
Day 2: User doesn't send DONE
Day 3: Cron runs at 00:10 AM → streak = 0 (2 days gap)
Day 3: User sends DONE at 9 AM → streak = 1 (restart)
```

### Example 4: Forgot Yesterday, Caught Up Today
```
Monday: User sends DONE → streak = 3
Tuesday: User forgets to send DONE
Wednesday: User sends DONE → streak = 1 (reset due to gap)
```

## WhatsApp Messages

When user sends "DONE", they receive:
```
Great job! Lesson marked as complete. 🎉

🔥 Current Streak: 7 days

See you tomorrow for Day 8!
```

(Note: Message shows "day" singular when streak is 1)

## Logging

### STREAK_UPDATED Log
```json
{
  "type": "STREAK_UPDATED",
  "userPhone": "919876543210",
  "message": "Streak updated to 7",
  "status": "SUCCESS",
  "timestamp": "2026-02-23T09:30:00.000Z",
  "metadata": {
    "streak": 7,
    "currentDay": 15
  }
}
```

### STREAK_RESET Log
```json
{
  "type": "STREAK_RESET",
  "userPhone": "919876543210",
  "message": "Streak reset from 5 to 0 due to missed day(s). Days gap: 3",
  "status": "INFO",
  "timestamp": "2026-02-24T00:10:00.000Z",
  "metadata": {
    "previousStreak": 5,
    "daysGap": 3,
    "lastCompletedDate": "2026-02-20T00:00:00.000Z"
  }
}
```

## Frontend Integration

### Displaying Streak in UI

```javascript
// Fetch user data
const response = await fetch(`/api/users/phone/${phone}`);
const user = await response.json();

// Display streak
<div>
  <h3>Your Progress</h3>
  <p>Current Day: {user.currentDay}</p>
  <p>🔥 Streak: {user.streak} day{user.streak !== 1 ? 's' : ''}</p>
  <p>Last Completed: {new Date(user.lastLessonCompletedDate).toLocaleDateString()}</p>
</div>
```

### Streak Badge/Icon

Show different icons based on streak milestones:
- 0-6 days: 🔥 (building)
- 7-13 days: 🔥🔥 (1 week)
- 14-29 days: 🔥🔥🔥 (2 weeks)
- 30+ days: 🏆 (champion)

## Testing

### Test Streak Increment
1. Create a test user
2. Send "DONE" command via WhatsApp
3. Check logs for "STREAK_UPDATED"
4. Query `/api/users/phone/:phone` to verify streak

### Test Streak Reset
1. Create user with old `lastLessonCompletedDate` (3 days ago)
2. Set user.streak to a non-zero value
3. Trigger: `POST /api/cron/trigger-streak-reset`
4. Verify streak is now 0

### Test Same Day Prevention
1. User sends "DONE" at 8 AM → check streak = 1
2. User sends "DONE" at 5 PM → verify streak still = 1

## Best Practices

1. **Always use UTC dates normalized to midnight** when comparing dates
2. **Log every streak change** for audit trail
3. **Run streak reset after midnight** (00:10 AM) to give users full 24 hours
4. **Display streak prominently** in UI to motivate users
5. **Consider streak milestones** for gamification (7 days, 30 days, etc.)

## Future Enhancements

- [ ] Send WhatsApp reminder when streak is about to break
- [ ] Award badges for streak milestones (7, 30, 60, 100 days)
- [ ] Leaderboard showing top streaks
- [ ] "Streak freeze" power-up (allow 1 missed day without reset)
- [ ] Monthly streak stats and achievements
