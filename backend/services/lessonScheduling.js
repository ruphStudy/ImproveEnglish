// Splits daily-lesson scheduling between the original 7:00 AM IST cron
// (cron/dailyLesson.js) and the local-time scheduler for learners in other
// time zones (cron/internationalLessonScheduler.js). Every user belongs to
// exactly one path; with the flag off, everyone stays on the IST cron.
const User = require('../models/User');
const { isInternationalTimezone, getZonedParts, zonedTimeToUtc } = require('../utils/timezone');

const LOCAL_LESSON_HOUR = 7;
const CATCH_UP_END_HOUR = 11; // a missed 7 AM run may still enqueue until 11:00 local, never later

function isInternationalSchedulingEnabled() {
  return process.env.INTERNATIONAL_SCHEDULING_ENABLED === 'true';
}

/** Stored timezone values (as stored) that belong to the international scheduler. */
async function getInternationalTimezones(filter = {}) {
  const values = await User.distinct('timezone', { ...filter, timezone: { $nin: [null, 'Asia/Kolkata'] } });
  return values.filter(isInternationalTimezone);
}

/**
 * Extra query filter for IST-scheduled jobs: excludes international learners
 * when the flag is on. Missing, Asia/Kolkata and unrecognised values all stay
 * on IST, so no learner can fall between the two paths.
 */
async function indiaScheduleFilter() {
  if (!isInternationalSchedulingEnabled()) return {};
  const international = await getInternationalTimezones();
  return international.length ? { timezone: { $nin: international } } : {};
}

/** Today's 7 AM window in `timezone` at `now`. */
function getLocalLessonWindow(now, timezone) {
  const p = getZonedParts(now, timezone);
  const day = { year: p.year, month: p.month, day: p.day };
  return {
    localDate: p.localDate,
    due: p.hour >= LOCAL_LESSON_HOUR && p.hour < CATCH_UP_END_HOUR,
    dayStart: zonedTimeToUtc({ ...day, hour: 0 }, timezone),
    lessonTime: zonedTimeToUtc({ ...day, hour: LOCAL_LESSON_HOUR }, timezone)
  };
}

/**
 * Daily lesson job id: learner + lesson day + scheduled (local) date.
 * Within one scheduling date every run, tick and instance produces the same id,
 * so Bull dedupes them. Bull also keeps finished/failed jobs (removeOnComplete /
 * removeOnFail), and an add() with a retained id is a silent no-op - the date
 * part means a job retained from an earlier day (failed, skipped as expired /
 * no topic, ...) can no longer block that learner's next scheduled notification.
 */
function lessonJobId(user, scheduleDate) {
  return `lesson-${user._id}-day${user.currentDay}-${scheduleDate}`;
}

/** Today's scheduling date for the IST cron (YYYY-MM-DD in Asia/Kolkata). */
function indiaScheduleDate(now = new Date()) {
  return getZonedParts(now, 'Asia/Kolkata').localDate;
}

/** Job options shared by the IST cron, the manual trigger and the international scheduler. */
function lessonJobOptions(user, scheduleDate) {
  return {
    jobId: lessonJobId(user, scheduleDate),
    priority: 1,
    removeOnComplete: 100,
    removeOnFail: 200
  };
}

module.exports = {
  LOCAL_LESSON_HOUR,
  CATCH_UP_END_HOUR,
  isInternationalSchedulingEnabled,
  getInternationalTimezones,
  indiaScheduleFilter,
  getLocalLessonWindow,
  lessonJobId,
  indiaScheduleDate,
  lessonJobOptions
};
