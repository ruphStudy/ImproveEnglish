const AiUsage = require('../models/AiUsage');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Log = require('../models/Log');
const { MODEL_PRICING, PRICING_VERSION, getUsdToInr } = require('../config/aiPricing');
const { getTrackingHealth } = require('../utils/aiUsageTracker');

const IST_OFFSET = '+05:30';
const IST_OFFSET_MS = 330 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const FORECAST_LEARNER_COUNTS = [100, 500, 1000, 10000];
const MIN_FORECAST_DAYS = 7;
const MIN_FORECAST_LEARNERS = 20;
const PER_USER_LIMIT = 200;

// ============================================================================
// IST calendar dates. All ranges are [start, end) - end is EXCLUSIVE, at IST
// midnight of the day after the last included date.
// ============================================================================

function istDateString(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMidnight(dateStr) {
  return new Date(`${dateStr}T00:00:00.000${IST_OFFSET}`);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidDateString(s) {
  return typeof s === 'string' && DATE_RE.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
}

/**
 * preset: 'today' | 'week' (last 7 IST days incl. today) | 'month' (current
 * IST calendar month to date) | 'custom' (from/to = inclusive IST dates).
 */
function resolveRange({ preset, from, to } = {}, now = new Date()) {
  if (!preset) preset = from && to ? 'custom' : 'today';
  const today = istDateString(now);
  let fromDate;
  let toDate = today;

  if (preset === 'today') fromDate = today;
  else if (preset === 'week') fromDate = addDays(today, -6);
  else if (preset === 'month') fromDate = `${today.slice(0, 7)}-01`;
  else if (preset === 'custom') {
    if (!isValidDateString(from) || !isValidDateString(to)) {
      return { error: '"from" and "to" must be dates in YYYY-MM-DD format' };
    }
    if (from > to) return { error: '"from" must be on or before "to"' };
    fromDate = from;
    toDate = to;
  } else {
    return { error: 'preset must be one of today, week, month, custom' };
  }

  const start = istMidnight(fromDate);
  const end = istMidnight(addDays(toDate, 1));
  const days = Math.round((end - start) / 86400000);
  if (days > MAX_RANGE_DAYS) return { error: `Range cannot exceed ${MAX_RANGE_DAYS} days` };

  return {
    preset,
    fromDate,
    toDate,
    start,
    end,
    days,
    includesToday: fromDate <= today && today <= toDate,
    timezone: 'Asia/Kolkata'
  };
}

/** One entry per IST date in range, zero-filled (requests) / null-safe (cost). */
function fillDaily(range, rows) {
  const byDate = new Map(rows.map(r => [r._id, r]));
  const out = [];
  for (let d = range.fromDate; d <= range.toDate; d = addDays(d, 1)) {
    const r = byDate.get(d);
    out.push({
      date: d,
      costUsd: r ? r.costUsd : 0,
      requests: r ? r.requests : 0,
      unknownCostRequests: r ? r.unknownCostRequests : 0
    });
  }
  return out;
}

function safeDivide(a, b) {
  return b > 0 ? a / b : null;
}

/**
 * Learner-days each learner was actually enrolled during the range: from the
 * IST day of their first lesson sent in the range (so mid-range joiners are
 * not counted for days before they started) until the range end or their
 * subscription expiry, whichever is first. Minimum 1 day per learner.
 * Days enrolled but inactive still count - an idle subscriber is still a learner.
 */
function computeLearnerDays(learners, range) {
  return learners.reduce((sum, l) => {
    const first = l.firstSentAt && l.firstSentAt > range.start ? l.firstSentAt : range.start;
    const startDay = istMidnight(istDateString(first));
    const endT = l.expiryDate && l.expiryDate < range.end ? l.expiryDate : range.end;
    const days = Math.ceil((endT - startDay) / 86400000);
    return sum + Math.max(1, days);
  }, 0);
}

/**
 * Forecast of 30-day OpenAI cost (AI only - excludes WhatsApp, AWS,
 * database and payment fees). Built from observed, attributed usage:
 *   recurring cost per learner-day = lesson + voice cost (retries included) of
 *     learners sent a lesson / their enrolled learner-days (computeLearnerDays)
 *   onboarding cost per new learner = onboarding cost / users with onboarding usage
 * Unattributed cost is shown as a fixed monthly amount, not scaled per learner.
 */
function buildForecast({ days, includesToday, lessonsSent, sentLearners, learnerDays, recurringCostUsd, onboardingCostUsd, onboardedUsers, unattributedCostUsd, unknownCostRequests }) {
  const warnings = [];
  if (days < MIN_FORECAST_DAYS) warnings.push(`Only ${days} day(s) of data - use at least ${MIN_FORECAST_DAYS} days for a reliable forecast.`);
  if (sentLearners < MIN_FORECAST_LEARNERS) warnings.push(`Only ${sentLearners} learner(s) were sent a lesson - at least ${MIN_FORECAST_LEARNERS} are needed for a reliable average.`);
  if (includesToday) warnings.push('Range includes today, which is still in progress.');
  if (unknownCostRequests > 0) warnings.push(`${unknownCostRequests} request(s) have unknown cost and are excluded, so the forecast may be low.`);

  if (!sentLearners || !days || !learnerDays) {
    return { available: false, reason: 'No learners were sent a lesson in this range.', warnings, rows: [] };
  }

  const perLearnerDayUsd = recurringCostUsd / learnerDays;
  const perLearner30DayUsd = perLearnerDayUsd * 30;
  const onboardingPerNewLearnerUsd = safeDivide(onboardingCostUsd, onboardedUsers);
  const unattributed30DayUsd = (unattributedCostUsd / days) * 30;

  return {
    available: true,
    warnings,
    assumptions: {
      basisDays: days,
      learnersSentLesson: sentLearners,
      learnerDays,
      lessonsSent,
      lessonsPerLearnerPerDay: lessonsSent / learnerDays,
      perLearnerDayUsd,
      perLearner30DayUsd,
      onboardingPerNewLearnerUsd,
      unattributed30DayUsd,
      notes: [
        'AI (OpenAI) cost only - excludes WhatsApp, AWS, database and payment gateway costs.',
        'Per-learner cost uses enrolled learner-days: from each learner\'s first lesson in the range to the range end or their expiry.',
        'Assumes the same lesson frequency, voice usage, retry rate and OpenAI prices as observed in this range.',
        'Onboarding is a one-time cost per new learner and is shown separately (zero if onboarding was not used).',
        'Unattributed cost is shown as a fixed monthly amount and is not scaled by learner count.',
        'Estimated from recorded usage - not OpenAI billing.'
      ]
    },
    rows: FORECAST_LEARNER_COUNTS.map(learners => ({
      learners,
      recurring30DayUsd: perLearner30DayUsd * learners,
      oneTimeOnboardingUsd: onboardingPerNewLearnerUsd === null ? null : onboardingPerNewLearnerUsd * learners,
      unattributed30DayUsd,
      total30DayUsd: perLearner30DayUsd * learners + unattributed30DayUsd
    }))
  };
}

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 4 ? `••••${s.slice(-4)}` : '';
}

const usageGroup = {
  requests: { $sum: 1 },
  failedRequests: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
  unknownCostRequests: { $sum: { $cond: ['$costKnown', 0, 1] } },
  costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
  inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
  cachedInputTokens: { $sum: { $ifNull: ['$cachedInputTokens', 0] } },
  outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
  audioSeconds: { $sum: { $ifNull: ['$audioSeconds', 0] } }
};

async function getAiCostReport(range, now = new Date()) {
  const dateMatch = { $gte: range.start, $lt: range.end };

  const [facet] = await AiUsage.aggregate([
    { $match: { createdAt: dateMatch } },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...usageGroup } }],
        byOperation: [{ $group: { _id: { operation: '$operation', category: '$category' }, ...usageGroup } }, { $sort: { costUsd: -1 } }],
        byModel: [{ $group: { _id: '$model', ...usageGroup } }, { $sort: { costUsd: -1 } }],
        daily: [{
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
            costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
            requests: { $sum: 1 },
            unknownCostRequests: { $sum: { $cond: ['$costKnown', 0, 1] } }
          }
        }],
        perUser: [
          { $match: { userId: { $ne: null } } },
          {
            $group: {
              _id: '$userId',
              ...usageGroup,
              lessonCostUsd: { $sum: { $cond: [{ $eq: ['$category', 'lesson'] }, { $ifNull: ['$costUsd', 0] }, 0] } },
              voiceCostUsd: { $sum: { $cond: [{ $eq: ['$category', 'voice'] }, { $ifNull: ['$costUsd', 0] }, 0] } },
              onboardingCostUsd: { $sum: { $cond: [{ $eq: ['$category', 'onboarding'] }, { $ifNull: ['$costUsd', 0] }, 0] } }
            }
          },
          { $sort: { costUsd: -1 } }
        ],
        unattributed: [{ $match: { userId: null } }, { $group: { _id: null, ...usageGroup } }]
      }
    }
  ]);

  const lessonSentMatch = { $or: [{ notifiedAt: dateMatch }, { sentAt: dateMatch }] };
  const [registered, activeSubscribed, sentLearners, completedLessons, completedLearnerIds, trackingErrors] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ isActive: true, $or: [{ expiryDate: { $gte: now } }, { expiryDate: null }] }),
    Lesson.aggregate([
      { $match: lessonSentMatch },
      { $group: { _id: '$userId', lessons: { $sum: 1 }, firstSentAt: { $min: { $ifNull: ['$notifiedAt', '$sentAt'] } } } }
    ]),
    Lesson.countDocuments({ completedAt: dateMatch }),
    Lesson.distinct('userId', { completedAt: dateMatch }),
    Log.countDocuments({ type: 'AI_USAGE_TRACKING_ERROR', createdAt: dateMatch })
  ]);

  const empty = { requests: 0, failedRequests: 0, unknownCostRequests: 0, costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: 0 };
  const totals = { ...empty, ...(facet.totals[0] || {}) };
  delete totals._id;
  const unattributed = { ...empty, ...(facet.unattributed[0] || {}) };
  delete unattributed._id;

  const sentLearnerIds = sentLearners.map(l => l._id);
  const lessonsSent = sentLearners.reduce((s, l) => s + l.lessons, 0);
  const expiries = await User.find({ _id: { $in: sentLearnerIds } }).select('expiryDate').lean();
  const expiryById = new Map(expiries.map(u => [String(u._id), u.expiryDate]));
  const learnerDays = computeLearnerDays(
    sentLearners.map(l => ({ firstSentAt: l.firstSentAt, expiryDate: expiryById.get(String(l._id)) || null })),
    range
  );

  const perUserRows = facet.perUser;
  const attributedCostUsd = perUserRows.reduce((s, u) => s + u.costUsd, 0);
  const sentSet = new Set(sentLearnerIds.map(String));
  const sentRows = perUserRows.filter(u => sentSet.has(String(u._id)));
  const costOfSentLearners = sentRows.reduce((s, u) => s + u.costUsd, 0);
  const recurringCostOfSentLearners = sentRows.reduce((s, u) => s + u.lessonCostUsd + u.voiceCostUsd, 0);
  const onboardingRows = perUserRows.filter(u => u.onboardingCostUsd > 0);

  const topUsers = perUserRows.slice(0, PER_USER_LIMIT);
  const userDocs = await User.find({ _id: { $in: topUsers.map(u => u._id) } }).select('name phone').lean();
  const userById = new Map(userDocs.map(u => [String(u._id), u]));

  const health = getTrackingHealth();
  const usdToInr = getUsdToInr();

  return {
    range: {
      preset: range.preset,
      fromDate: range.fromDate,
      toDate: range.toDate,
      start: range.start.toISOString(),
      endExclusive: range.end.toISOString(),
      days: range.days,
      timezone: range.timezone
    },
    currency: { source: 'USD', usdToInr, inrIsApproximate: true },
    pricing: { version: PRICING_VERSION, models: MODEL_PRICING },
    totals,
    byOperation: facet.byOperation.map(r => ({ operation: r._id.operation, category: r._id.category, ...omitId(r) })),
    byModel: facet.byModel.map(r => ({ model: r._id, ...omitId(r) })),
    daily: fillDaily(range, facet.daily),
    users: {
      registered,
      activeSubscribed,
      sentLesson: sentLearnerIds.length,
      completedLesson: completedLearnerIds.length,
      incurredAiCost: perUserRows.length
    },
    lessons: { sent: lessonsSent, completed: completedLessons },
    averages: {
      costPerUserWithAiUsageUsd: safeDivide(attributedCostUsd, perUserRows.length),
      costPerLearnerSentLessonUsd: safeDivide(costOfSentLearners, sentLearnerIds.length),
      costPerCompletedLessonUsd: safeDivide(totals.costUsd, completedLessons)
    },
    perUser: topUsers.map(u => {
      const doc = userById.get(String(u._id));
      return { userId: String(u._id), name: doc ? doc.name : '(deleted user)', phone: doc ? maskPhone(doc.phone) : '', ...omitId(u) };
    }),
    perUserTruncated: perUserRows.length > PER_USER_LIMIT,
    unattributed,
    forecast: buildForecast({
      days: range.days,
      includesToday: range.includesToday,
      lessonsSent,
      sentLearners: sentLearnerIds.length,
      learnerDays,
      recurringCostUsd: recurringCostOfSentLearners,
      onboardingCostUsd: onboardingRows.reduce((s, u) => s + u.onboardingCostUsd, 0),
      onboardedUsers: onboardingRows.length,
      unattributedCostUsd: unattributed.costUsd,
      unknownCostRequests: totals.unknownCostRequests
    }),
    trackingHealth: {
      trackingErrorsInRange: trackingErrors,
      unknownCostRequests: totals.unknownCostRequests,
      failedRequests: totals.failedRequests,
      process: health,
      trackingStartedNote: 'Usage is recorded only from when tracking was deployed. Earlier OpenAI costs are not reconstructed.'
    }
  };
}

function omitId(row) {
  const { _id, ...rest } = row;
  return rest;
}

module.exports = { resolveRange, fillDaily, buildForecast, computeLearnerDays, getAiCostReport, istDateString, istMidnight };
