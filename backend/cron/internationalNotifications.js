const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');
const redisClient = require('../config/redisClient');
const { sendTemplateMessage } = require('../services/whatsappService');
const { runWithCronLock } = require('../utils/cronLock');
const { getZonedParts } = require('../utils/timezone');
const { isInternationalSchedulingEnabled, getInternationalTimezones } = require('../services/lessonScheduling');
const { getWeeklyActivityStats, hadWeeklyActivity } = require('../services/retentionService');
const LearnerEvent = require('../models/LearnerEvent');

/**
 * Weekly summaries (Sunday 18:00 local) and subscription expiry reminders
 * (09:00 local) for international learners - every 5 minutes, behind
 * INTERNATIONAL_SCHEDULING_ENABLED. Indian learners (and everyone while the
 * flag is off) keep cron/weeklySummary.js and cron/expiryReminder.js, which
 * exclude international learners when the flag is on - nobody gets both.
 *
 * Same templates, parameters and eligibility as the IST jobs. Every send is
 * claimed first with an atomic conditional update (weekly: weeklySummaryDate;
 * expiry: the existing sevenDay/threeDayReminderSent flags), so ticks, restarts
 * and concurrent instances cannot send twice. Windows close early (21:00 / 12:00
 * local): a missed run is caught up only within them, never late at night.
 */

const WEEKLY = { weekday: 0, fromHour: 18, untilHour: 21 }; // Sunday
const EXPIRY = { fromHour: 9, untilHour: 12 };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const MARKER_TTL_SECONDS = 2 * 24 * 60 * 60;

function localWeekday(p) {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Whole local calendar days from `now` to the expiry instant, both in `timezone`. */
function localDaysUntil(expiryDate, now, timezone) {
  const e = getZonedParts(expiryDate, timezone);
  const t = getZonedParts(now, timezone);
  return Math.round((Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(t.year, t.month - 1, t.day)) / ONE_DAY_MS);
}

/** Which expiry reminder (if any) applies `days` local days before expiry - same bands as the IST job. */
function expiryReminderFor(days) {
  if (days > 3 && days <= 7) return { flag: 'sevenDayReminderSent', template: 'expiry_reminder_7_days_new', logType: 'EXPIRY_REMINDER_7_DAYS' };
  if (days >= 0 && days <= 3) return { flag: 'threeDayReminderSent', template: 'expiry_reminder_3_days_new', logType: 'EXPIRY_REMINDER_3_DAYS' };
  return null;
}

async function zoneDone(key) {
  try { return (await redisClient.get(key)) !== null; } catch { return false; }
}
async function markZoneDone(key) {
  try { await redisClient.set(key, '1', 'EX', MARKER_TTL_SECONDS); } catch { /* next tick re-checks; claims prevent duplicates */ }
}

async function runWeeklyForZone(timezone, p, now, summary) {
  const localDate = p.localDate;
  const users = await User.find({ timezone, isActive: true, whatsappOptOut: { $ne: true }, weeklySummaryDate: { $ne: localDate } }).select('_id name phone streak').lean();
  const sinceDate = new Date(now.getTime() - ONE_WEEK_MS);
  for (const user of users) {
    // Claim this week's run for the user and reset the weekly counter, as the IST job does for everyone.
    const claim = await User.updateOne(
      { _id: user._id, weeklySummaryDate: { $ne: localDate } },
      { $set: { weeklySummaryDate: localDate, weeklyCompletedCount: 0 } }
    );
    if (!claim.modifiedCount) continue;
    try {
      const stats = await getWeeklyActivityStats(user._id, sinceDate);
      if (!hadWeeklyActivity(stats)) continue; // never a "progress" report for an inactive week
      await sendTemplateMessage(user.phone, 'weekly_summary_new', [user.name, stats.lessonsCompleted.toString(), (user.streak || 0).toString()], 'en_US');
      summary.weeklySent++;
      await Log.create({
        type: 'WEEKLY_SUMMARY_SENT',
        userPhone: user.phone,
        message: `Weekly summary sent: ${stats.lessonsCompleted} lessons, ${stats.speakingAttemptsCount} speaking practices, ${user.streak || 0} streak (${timezone})`,
        status: 'SUCCESS',
        metadata: { ...stats, timezone, scheduler: 'international' }
      }).catch(() => {});
    } catch (err) {
      summary.failed++; // not retried: at most one summary per week (as the IST job)
      await Log.create({ type: 'WEEKLY_SUMMARY_ERROR', userPhone: user.phone, message: `Failed to send weekly summary: ${err.message}`, status: 'ERROR', metadata: { timezone } }).catch(() => {});
    }
  }
}

async function runExpiryForZone(timezone, now, summary) {
  const users = await User.find({
    timezone,
    isActive: true,
    whatsappOptOut: { $ne: true },
    expiryDate: { $gt: now, $lte: new Date(now.getTime() + 8 * ONE_DAY_MS) },
    $or: [{ sevenDayReminderSent: false }, { threeDayReminderSent: false }]
  }).select('_id name phone expiryDate sevenDayReminderSent threeDayReminderSent').lean();

  for (const user of users) {
    const days = localDaysUntil(user.expiryDate, now, timezone);
    const reminder = expiryReminderFor(days);
    if (!reminder || user[reminder.flag]) continue;
    const claimFilter = { _id: user._id, isActive: true, expiryDate: user.expiryDate, [reminder.flag]: false };
    const claim = await User.updateOne(claimFilter, { $set: { [reminder.flag]: true } });
    if (!claim.modifiedCount) continue; // another tick/instance sent it, or the plan changed

    try {
      await sendTemplateMessage(user.phone, reminder.template, [user.name], 'en_US');
      summary.expirySent++;
      await LearnerEvent.create({
        userId: user._id, type: 'EXPIRY_REMINDER_SENT', dedupeKey: `${reminder.flag}-${new Date(user.expiryDate).toISOString()}`,
        metadata: { status: 'accepted', template: reminder.template }
      }).catch(() => {});
      await Log.create({
        type: reminder.logType,
        userPhone: user.phone,
        message: `${reminder.logType === 'EXPIRY_REMINDER_7_DAYS' ? '7' : '3'}-day expiry reminder sent (${timezone}, ${days} local day(s) left)`,
        status: 'SUCCESS',
        metadata: { daysRemaining: days, expiryDate: user.expiryDate, timezone, scheduler: 'international' }
      }).catch(() => {});
    } catch (err) {
      summary.failed++;
      // Like the IST job, a failed send is retried on the next daily run: release the
      // claim (only if still ours); the zone's daily marker stops same-day retries.
      await User.updateOne({ ...claimFilter, [reminder.flag]: true }, { $set: { [reminder.flag]: false } }).catch(() => {});
      await Log.create({ type: 'EXPIRY_REMINDER_ERROR', userPhone: user.phone, message: `Failed to send expiry reminder: ${err.message}`, status: 'ERROR', metadata: { timezone } }).catch(() => {});
    }
  }
}

async function runInternationalNotificationsInner(now) {
  const summary = { weeklySent: 0, expirySent: 0, failed: 0 };
  const zones = await getInternationalTimezones({ isActive: true });

  for (const timezone of zones) {
    const p = getZonedParts(now, timezone);
    if (localWeekday(p) === WEEKLY.weekday && p.hour >= WEEKLY.fromHour && p.hour < WEEKLY.untilHour) {
      await runWeeklyForZone(timezone, p, now, summary); // per-user claims make re-runs harmless
    }
    if (p.hour >= EXPIRY.fromHour && p.hour < EXPIRY.untilHour) {
      const key = `intl-expiry:done:${timezone}:${p.localDate}`;
      if (!(await zoneDone(key))) {
        await runExpiryForZone(timezone, now, summary);
        await markZoneDone(key); // once per local day, so a failed send waits for tomorrow
      }
    }
  }

  if (summary.weeklySent || summary.expirySent || summary.failed) {
    await Log.create({
      type: summary.weeklySent ? 'CRON_WEEKLY_SUMMARY' : 'CRON_EXPIRY_REMINDER',
      message: `International notifications: ${summary.weeklySent} weekly, ${summary.expirySent} expiry, ${summary.failed} failed`,
      status: summary.failed ? 'WARNING' : 'SUCCESS',
      metadata: { scheduler: 'international', ...summary }
    }).catch(() => {});
  }
  return summary;
}

async function runInternationalNotifications({ now = new Date() } = {}) {
  if (!isInternationalSchedulingEnabled()) return { skipped: true, reason: 'disabled' };
  return runWithCronLock('intl-notifications', 240, () => runInternationalNotificationsInner(now), { failOpen: false });
}

cron.schedule('*/5 * * * *', () => {
  runInternationalNotifications().catch(async (err) => {
    console.error('❌ International notification scheduler error:', err);
    await Log.create({ type: 'ERROR', message: `International notification scheduler error: ${err.message}` }).catch(() => {});
  });
});

module.exports = { runInternationalNotifications, localDaysUntil, expiryReminderFor };
