const cron = require('node-cron');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const LearnerEvent = require('../models/LearnerEvent');
const Log = require('../models/Log');
const redisClient = require('../config/redisClient');
const { sendTemplateMessage } = require('../services/whatsappService');
const { runWithCronLock } = require('../utils/cronLock');
const { getZonedParts, zonedTimeToUtc, DEFAULT_TIMEZONE } = require('../utils/timezone');
const {
  isInternationalSchedulingEnabled,
  getInternationalTimezones,
  indiaScheduleFilter
} = require('../services/lessonScheduling');
const { getSubscriptionCycleMap } = require('../services/subscriptionCycles');

/**
 * Template-based beta retention (RETENTION_ENGINE_ENABLED, default off). When on,
 * it replaces cron/retentionEngine.js (plain-text Day-30 report, upgrade nudges
 * and READY-user comeback messages, which that job then skips).
 *
 * Runs every 5 minutes; a learner group is processed once per local date from
 * 17:00 local (IST for everyone while INTERNATIONAL_SCHEDULING_ENABLED is off),
 * with catch-up until 20:00. Two optional "account" messages, at most one per
 * learner per local date, and never on a date an expiry reminder was sent:
 *
 * 1. lesson waiting reminder - WAITING_START learners, about the SAME pending
 *    lesson (currentDay), on local day +1 (or +2 catch-up) and +3 (or +4) after
 *    the notification; never more than two. Ends as soon as they reply START.
 * 2. progress update - 30-day plans (paid or BETA100), once per cycle on local
 *    subscription day 25-27, counting lessons completed and speaking attempts in
 *    THIS cycle; only while the plan is still active.
 *
 * Nothing here changes currentDay, creates lessons or extends expiry. Templates
 * come from env; an unset template means "not approved yet" - nothing is claimed
 * or sent. Each send is claimed first with a LearnerEvent (unique per learner,
 * type and key), and its outcome (accepted / failed) recorded on that event.
 * Learners who replied STOP REMINDERS (retentionOptOut) are skipped.
 */

const SEND_FROM_HOUR = 17;
const SEND_UNTIL_HOUR = 20;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_TTL_SECONDS = 2 * 24 * 60 * 60;
const ACCOUNT_MESSAGE_EVENTS = ['LESSON_WAITING_REMINDER', 'PROGRESS_UPDATE', 'EXPIRY_REMINDER_SENT'];

function isRetentionEngineEnabled() {
  return process.env.RETENTION_ENGINE_ENABLED === 'true';
}

function templates() {
  return {
    waiting: (process.env.WHATSAPP_LESSON_WAITING_TEMPLATE || '').trim(),
    progress: (process.env.WHATSAPP_PROGRESS_UPDATE_TEMPLATE || '').trim(),
    lang: (process.env.WHATSAPP_RETENTION_TEMPLATE_LANG || 'en_US').trim()
  };
}

/** Whole local calendar days from `from` to `to` in `timezone`. */
function localDaysBetween(from, to, timezone) {
  const a = getZonedParts(from, timezone);
  const b = getZonedParts(to, timezone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / ONE_DAY_MS);
}

function localDayBounds(now, timezone) {
  const p = getZonedParts(now, timezone);
  return {
    start: zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0 }, timezone),
    end: zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + 1, hour: 0 }, timezone)
  };
}

/** Which waiting reminder (1 or 2) applies `days` local days after the notification. */
function waitingReminderNumber(days) {
  if (days === 1 || days === 2) return 1;
  if (days === 3 || days === 4) return 2;
  return null;
}

function formatDate(date, timezone) {
  return date.toLocaleDateString('en-GB', { timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric' });
}

async function hadAccountMessageToday(userId, bounds) {
  return !!(await LearnerEvent.exists({
    userId,
    type: { $in: ACCOUNT_MESSAGE_EVENTS },
    occurredAt: { $gte: bounds.start, $lt: bounds.end },
    'metadata.status': { $ne: 'failed' }
  }));
}

/** Claim (unique event) -> send -> record outcome. Returns 'accepted' | 'failed' | 'duplicate'. */
async function claimAndSend(user, type, dedupeKey, template, params, lang, meta, now) {
  let event;
  try {
    event = await LearnerEvent.create({ userId: user._id, type, dedupeKey, occurredAt: now, metadata: { ...meta, status: 'claimed', template } });
  } catch (err) {
    if (err.code === 11000) return 'duplicate';
    throw err;
  }
  try {
    const response = await sendTemplateMessage(user.phone, template, params, lang);
    await LearnerEvent.updateOne({ _id: event._id }, { $set: { 'metadata.status': 'accepted', 'metadata.messageId': response?.messages?.[0]?.id || null } });
    return 'accepted';
  } catch (err) {
    // Not retried: at most one attempt per reminder, never a duplicate.
    await LearnerEvent.updateOne({ _id: event._id }, { $set: { 'metadata.status': 'failed', 'metadata.error': String(err.message).slice(0, 200) } });
    return 'failed';
  }
}

async function processGroup(timezone, filter, now, tpl, summary) {
  const bounds = localDayBounds(now, timezone);
  const base = {
    ...filter,
    isActive: true,
    retentionOptOut: { $ne: true },
    whatsappOptOut: { $ne: true },
    $or: [{ expiryDate: { $gt: now } }, { expiryDate: null }]
  };

  // 1. Same-lesson waiting reminders
  const waiting = await User.find({ ...base, state: 'WAITING_START', lastNotificationDate: { $lt: bounds.start } })
    .select('_id name phone currentDay lastNotificationDate').lean();
  const handled = new Set();
  for (const user of waiting) {
    const days = localDaysBetween(user.lastNotificationDate, now, timezone);
    const number = waitingReminderNumber(days);
    if (!number) continue;
    if (!tpl.waiting) { summary.skippedUnconfigured++; continue; }
    if (await hadAccountMessageToday(user._id, bounds)) { summary.skippedSameDay++; handled.add(String(user._id)); continue; }
    // One key per pending notification; reminder 2 is only sent if reminder 1's slot has passed.
    const key = `day${user.currentDay}-${new Date(user.lastNotificationDate).getTime()}-${number}`;
    const result = await claimAndSend(user, 'LESSON_WAITING_REMINDER', key, tpl.waiting,
      [user.name, String(user.currentDay)], tpl.lang, { day: user.currentDay, reminder: number, timezone }, now);
    summary[result]++;
    handled.add(String(user._id));
  }

  // 2. Progress update for 30-day plans around subscription day 25
  const candidates = await User.find({ ...base, expiryDate: { $gt: now } }).select('_id name phone expiryDate').lean();
  const cycles = await getSubscriptionCycleMap(candidates.map(u => u._id));
  for (const user of candidates) {
    if (handled.has(String(user._id))) continue;
    const cycle = cycles.get(String(user._id));
    if (!cycle || cycle.planDuration !== 30) continue;
    const day = localDaysBetween(cycle.startedAt, now, timezone) + 1; // subscription day (1 = start date)
    if (day < 25 || day > 27) continue;
    if (!tpl.progress) { summary.skippedUnconfigured++; continue; }
    if (await LearnerEvent.exists({ userId: user._id, type: 'PROGRESS_UPDATE', dedupeKey: cycle.cycleKey })) continue;
    if (await hadAccountMessageToday(user._id, bounds)) { summary.skippedSameDay++; continue; }
    const [lessons, attempts] = await Promise.all([
      Lesson.countDocuments({ userId: user._id, status: 'completed', completedAt: { $gte: cycle.startedAt } }),
      SpeakingAttempt.countDocuments({ userId: user._id, createdAt: { $gte: cycle.startedAt } })
    ]);
    const result = await claimAndSend(user, 'PROGRESS_UPDATE', cycle.cycleKey, tpl.progress,
      [user.name, String(lessons), String(attempts), formatDate(user.expiryDate, timezone)], tpl.lang,
      { source: cycle.source, subscriptionDay: day, lessons, attempts, timezone }, now);
    summary[result]++;
  }
}

async function zoneDone(key) {
  try { return (await redisClient.get(key)) !== null; } catch { return false; }
}
async function markZoneDone(key) {
  try { await redisClient.set(key, '1', 'EX', MARKER_TTL_SECONDS); } catch { /* next tick re-checks; claims prevent duplicates */ }
}

async function runRetentionMessagesInner(now) {
  const tpl = templates();
  const summary = { accepted: 0, failed: 0, duplicate: 0, skippedUnconfigured: 0, skippedSameDay: 0, groups: 0 };
  // India group: everyone at IST while the international flag is off; otherwise
  // IST learners only, and each international time zone at its own 17:00.
  const groups = [{ timezone: DEFAULT_TIMEZONE, filter: await indiaScheduleFilter(), marker: 'india' }];
  if (isInternationalSchedulingEnabled()) {
    for (const tz of await getInternationalTimezones({ isActive: true })) groups.push({ timezone: tz, filter: { timezone: tz }, marker: tz });
  }

  for (const group of groups) {
    const p = getZonedParts(now, group.timezone);
    if (p.hour < SEND_FROM_HOUR || p.hour >= SEND_UNTIL_HOUR) continue;
    const key = `retention:done:${group.marker}:${p.localDate}`;
    if (await zoneDone(key)) continue;
    summary.groups++;
    await processGroup(group.timezone, group.filter, now, tpl, summary);
    await markZoneDone(key);
  }

  if (summary.groups) {
    await Log.create({
      type: 'CRON_RETENTION_ENGINE',
      message: `Retention messages: ${summary.accepted} accepted, ${summary.failed} failed, ${summary.skippedUnconfigured} skipped (template not configured), ${summary.skippedSameDay} skipped (already messaged today)`,
      status: summary.failed ? 'WARNING' : 'SUCCESS',
      metadata: { engine: 'templates', ...summary }
    }).catch(() => {});
  }
  return summary;
}

async function runRetentionMessages({ now = new Date() } = {}) {
  if (!isRetentionEngineEnabled()) return { skipped: true, reason: 'disabled' };
  return runWithCronLock('retention-messages', 240, () => runRetentionMessagesInner(now), { failOpen: false });
}

cron.schedule('*/5 * * * *', () => {
  runRetentionMessages().catch(async (err) => {
    console.error('❌ Retention messages error:', err);
    await Log.create({ type: 'ERROR', message: `Retention messages error: ${err.message}` }).catch(() => {});
  });
});

module.exports = { runRetentionMessages, isRetentionEngineEnabled, waitingReminderNumber, localDaysBetween };
