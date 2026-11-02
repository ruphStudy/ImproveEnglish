const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');
const { sendTemplateMessage } = require('../services/whatsappService');
const { runWithCronLock } = require('../utils/cronLock');
const { getZonedParts, zonedTimeToUtc } = require('../utils/timezone');
const { isInternationalSchedulingEnabled, getInternationalTimezones } = require('../services/lessonScheduling');

/**
 * Noon / evening lesson reminders at learner-local time for international
 * learners - every 5 minutes, behind INTERNATIONAL_SCHEDULING_ENABLED.
 * Indian learners (and everyone while the flag is off) keep cron/lessonReminder.js
 * at 12:00 / 18:00 IST; that job excludes international learners when the
 * flag is on, so nobody gets both.
 *
 * Same templates and parameters as the IST reminders. A reminder goes only to a
 * WAITING_START learner whose lesson notification was sent on the current LOCAL
 * date. Each send is claimed first with an atomic conditional update of the
 * existing reminder flag (still WAITING_START, same notification, flag unset), so
 * restarts, delayed ticks and concurrent instances cannot send it twice. A send
 * that fails after the claim is not retried (at most one reminder, never a duplicate).
 */

// [start, end) local hours. A missed tick can catch up within the window, never later
// (no noon reminder in the evening, no evening reminder near bedtime).
const REMINDERS = [
  { key: 'noon', template: 'lesson_reminder_noon', flag: 'noonReminderSent', fromHour: 12, untilHour: 15, logType: 'LESSON_REMINDER_NOON' },
  { key: 'evening', template: 'lesson_reminder_evening', flag: 'eveningReminderSent', fromHour: 18, untilHour: 21, logType: 'LESSON_REMINDER_EVENING' }
];

function dueReminder(now, timezone) {
  const { hour } = getZonedParts(now, timezone);
  return REMINDERS.find(r => hour >= r.fromHour && hour < r.untilHour) || null;
}

/** [start, end) of the learner's current local calendar day, as UTC instants. */
function localDayBounds(now, timezone) {
  const p = getZonedParts(now, timezone);
  return {
    start: zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0 }, timezone),
    end: zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + 1, hour: 0 }, timezone)
  };
}

function eligibleQuery(timezone, reminder, bounds, now) {
  return {
    timezone,
    state: 'WAITING_START',
    isActive: true,
    whatsappOptOut: { $ne: true },
    [reminder.flag]: false,
    lastNotificationDate: { $gte: bounds.start, $lt: bounds.end },
    $or: [{ expiryDate: { $gte: now } }, { expiryDate: null }]
  };
}

async function runInternationalRemindersInner(now) {
  const summary = { zonesDue: 0, sent: 0, failed: 0 };
  const zones = await getInternationalTimezones({ isActive: true, state: 'WAITING_START' });

  for (const timezone of zones) {
    const reminder = dueReminder(now, timezone);
    if (!reminder) continue;
    summary.zonesDue++;
    const query = eligibleQuery(timezone, reminder, localDayBounds(now, timezone), now);
    const learners = await User.find(query).select('_id name phone currentDay lastNotificationDate').lean();

    for (const learner of learners) {
      // Claim: only one tick/instance can flip the flag for this pending lesson.
      const claim = await User.updateOne(
        { ...query, _id: learner._id, currentDay: learner.currentDay, lastNotificationDate: learner.lastNotificationDate },
        { $set: { [reminder.flag]: true } }
      );
      if (!claim.modifiedCount) continue; // already sent, or the learner replied START meanwhile

      try {
        await sendTemplateMessage(learner.phone, reminder.template, [learner.name, learner.currentDay.toString()], 'en_US');
        summary.sent++;
        await Log.create({
          type: reminder.logType,
          userPhone: learner.phone,
          message: `${reminder.key === 'noon' ? 'Noon' : 'Evening'} reminder sent for Day ${learner.currentDay} (${timezone})`,
          status: 'SUCCESS',
          metadata: { day: learner.currentDay, notificationDate: learner.lastNotificationDate, timezone, scheduler: 'international' }
        }).catch(() => {});
      } catch (err) {
        summary.failed++;
        console.error(`❌ Failed to send ${reminder.key} reminder to ${learner.phone}:`, err.message);
        await Log.create({
          type: 'LESSON_REMINDER_ERROR',
          userPhone: learner.phone,
          message: `${reminder.key} reminder failed (not retried): ${err.message}`,
          status: 'ERROR',
          metadata: { timezone, scheduler: 'international' }
        }).catch(() => {});
      }
    }
  }

  if (summary.sent || summary.failed) {
    await Log.create({
      type: 'CRON_LESSON_REMINDER',
      message: `International reminders: ${summary.sent} sent, ${summary.failed} failed`,
      status: summary.failed ? 'WARNING' : 'SUCCESS',
      metadata: { scheduler: 'international', ...summary }
    }).catch(() => {});
  }
  return summary;
}

async function runInternationalLessonReminders({ now = new Date() } = {}) {
  if (!isInternationalSchedulingEnabled()) return { skipped: true, reason: 'disabled' };
  // Fail closed like the international lesson scheduler: Redis down = skip this tick.
  return runWithCronLock('intl-lesson-reminders', 240, () => runInternationalRemindersInner(now), { failOpen: false });
}

cron.schedule('*/5 * * * *', () => {
  runInternationalLessonReminders().catch(async (err) => {
    console.error('❌ International reminder scheduler error:', err);
    await Log.create({ type: 'ERROR', message: `International reminder scheduler error: ${err.message}` }).catch(() => {});
  });
});

module.exports = { runInternationalLessonReminders, dueReminder, localDayBounds };
