const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');
const redisClient = require('../config/redisClient');
const { lessonQueue } = require('../config/queueConfig');
const { runWithCronLock } = require('../utils/cronLock');
const {
  isInternationalSchedulingEnabled,
  getInternationalTimezones,
  getLocalLessonWindow,
  lessonJobOptions
} = require('../services/lessonScheduling');

/**
 * International daily lessons - every 5 minutes, behind INTERNATIONAL_SCHEDULING_ENABLED.
 *
 * For each non-India time zone where it is 07:00-10:59 local, queues READY
 * learners exactly like the 7 AM IST cron does (same queue, job id and
 * worker), so the worker's READY / already-notified / lesson-reuse checks
 * still apply and no extra AI generation is triggered.
 *
 * Duplicate safety does not depend on a pre-written marker:
 * - per learner: only those not notified on this local date (lastNotificationDate),
 *   who were already READY at 7:00 local (registered and last START before 7:00),
 *   mirroring "READY when the 7 AM IST cron runs";
 * - per job: the deterministic job id makes repeated ticks / instances no-ops;
 * - per run: a Redis lock that fails CLOSED (Redis down = skip; the next tick retries).
 * The per-zone "done" marker is written only after every learner in the zone was
 * queued without error - it just saves queries; a crash before it means the next
 * tick re-checks the zone, and the guards above keep that safe.
 *
 * Scheduling starts at 7:00 local; queue processing and WhatsApp delivery
 * add a small delay. Nothing is queued after 11:00 local.
 */

const DONE_MARKER_TTL_SECONDS = 2 * 24 * 60 * 60;

const doneKey = (timezone, localDate) => `intl-lesson:done:${timezone}:${localDate}`;

async function isZoneDone(key) {
  try {
    return (await redisClient.get(key)) !== null;
  } catch {
    return false; // re-check the zone; the per-learner guards prevent duplicates
  }
}

async function markZoneDone(key) {
  try {
    await redisClient.set(key, '1', 'EX', DONE_MARKER_TTL_SECONDS);
  } catch {
    // ignore - the next tick simply re-checks this zone
  }
}

function eligibleLearnersQuery(timezone, window, now) {
  return {
    isActive: true,
    state: 'READY',
    whatsappOptOut: { $ne: true },
    timezone,
    createdAt: { $lt: window.lessonTime },
    $and: [
      { $or: [{ expiryDate: { $gte: now } }, { expiryDate: null }] },
      { $or: [{ lastNotificationDate: null }, { lastNotificationDate: { $lt: window.dayStart } }] },
      { $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: window.lessonTime } }] }
    ]
  };
}

async function runInternationalLessonSchedulerInner(now) {
  const summary = { zonesChecked: 0, zonesDue: 0, queued: 0, failed: 0 };
  const zones = await getInternationalTimezones({ isActive: true, state: 'READY' });
  summary.zonesChecked = zones.length;

  for (const timezone of zones) {
    const window = getLocalLessonWindow(now, timezone);
    if (!window.due) continue;
    const key = doneKey(timezone, window.localDate);
    if (await isZoneDone(key)) continue;
    summary.zonesDue++;

    const learners = await User.find(eligibleLearnersQuery(timezone, window, now)).select('_id currentDay').lean();
    let zoneFailures = 0;
    for (const learner of learners) {
      try {
        await lessonQueue.add({ userId: learner._id.toString() }, lessonJobOptions(learner, window.localDate));
        summary.queued++;
      } catch (err) {
        zoneFailures++;
        console.error(`❌ International scheduler: could not queue ${learner._id} (${timezone}):`, err.message);
      }
    }
    summary.failed += zoneFailures;
    if (!zoneFailures) await markZoneDone(key);
  }

  if (summary.zonesDue) {
    await Log.create({
      type: 'CRON_LESSON',
      message: `International lesson scheduler: queued ${summary.queued} learner(s) in ${summary.zonesDue} time zone(s)` +
        (summary.failed ? `, ${summary.failed} failed (retried next tick)` : ''),
      status: summary.failed ? 'WARNING' : 'SUCCESS',
      metadata: { scheduler: 'international', ...summary }
    }).catch(() => {});
  }
  return summary;
}

async function runInternationalLessonScheduler({ now = new Date() } = {}) {
  if (!isInternationalSchedulingEnabled()) return { skipped: true, reason: 'disabled' };
  // Fail closed: if Redis cannot confirm the lock, skip - the next 5-minute tick retries.
  return runWithCronLock('intl-daily-lesson', 240, () => runInternationalLessonSchedulerInner(now), { failOpen: false });
}

cron.schedule('*/5 * * * *', () => {
  runInternationalLessonScheduler().catch(async (err) => {
    console.error('❌ International lesson scheduler error:', err);
    await Log.create({ type: 'ERROR', message: `International lesson scheduler error: ${err.message}` }).catch(() => {});
  });
});

module.exports = { runInternationalLessonScheduler, eligibleLearnersQuery };
