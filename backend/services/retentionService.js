const User = require('../models/User');
const Lesson = require('../models/Lesson');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const TutorMemory = require('../models/TutorMemory');
const PaymentHistory = require('../models/PaymentHistory');
const LearnerEvent = require('../models/LearnerEvent');
const { GOAL_LABELS } = require('./assessmentService');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = [1, 3, 7, 14, 30];
const DAY_MILESTONES = [1, 3, 7, 14, 30];

// ============================================================================
// EVENT RECORDING - all writes go through here; idempotency is enforced by
// LearnerEvent's unique (userId, type, dedupeKey) index, not by app logic.
// Never throws - milestone tracking must never break the calling user flow.
// ============================================================================

async function recordLearnerEvent(userId, type, { dedupeKey = 'default', metadata, occurredAt } = {}) {
  try {
    return await LearnerEvent.create({ userId, type, dedupeKey, metadata, occurredAt: occurredAt || new Date() });
  } catch (err) {
    if (err.code === 11000) return null; // already recorded - idempotent no-op
    console.error(`[LearnerEvent] Failed to record ${type} for ${userId}:`, err.message);
    return null;
  }
}

/**
 * Legacy activation approximation used only by funnel time-to-milestone
 * calculations (not the retention cohort anchor - see getRetentionAnchor
 * below). Kept separate deliberately: this sprint's fix is scoped to
 * retention/DAY_N_ACTIVE only, per the task that introduced it.
 */
function getActivationDate(user) {
  return user.createdAt;
}

/**
 * Business retention cohort anchor, in priority order:
 *   1. earliest SUBSCRIPTION_ACTIVATED LearnerEvent (the initial paid
 *      acquisition - renewals/upgrades never create a new one of these,
 *      so this never resets on renewal/upgrade)
 *   2. earliest successful PaymentHistory row (covers users whose
 *      activation event is missing, e.g. predates Prompt 7)
 *   3. User.createdAt (final legacy fallback, no migration required)
 *
 * Bulk variant for many users at once (used by calculateRetentionMetrics);
 * single-user convenience wrapper below reuses it so there is exactly one
 * place this priority order is implemented.
 */
async function getRetentionAnchorsForUsers(users) {
  const anchors = new Map(); // userId(string) -> Date
  const userIds = users.map(u => u._id);
  if (!userIds.length) return anchors;

  const activationRows = await LearnerEvent.aggregate([
    { $match: { userId: { $in: userIds }, type: 'SUBSCRIPTION_ACTIVATED' } },
    { $sort: { occurredAt: 1 } },
    { $group: { _id: '$userId', occurredAt: { $first: '$occurredAt' } } }
  ]);
  activationRows.forEach(r => anchors.set(String(r._id), new Date(r.occurredAt)));

  const missingAfterTier1 = userIds.filter(id => !anchors.has(String(id)));
  if (missingAfterTier1.length) {
    const paymentRows = await PaymentHistory.aggregate([
      { $match: { userId: { $in: missingAfterTier1 }, paymentStatus: 'success' } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$userId', createdAt: { $first: '$createdAt' } } }
    ]);
    paymentRows.forEach(r => anchors.set(String(r._id), new Date(r.createdAt)));
  }

  users.forEach(u => {
    if (!anchors.has(String(u._id)) && u.createdAt) {
      anchors.set(String(u._id), new Date(u.createdAt));
    }
  });

  return anchors;
}

async function getRetentionAnchor(userId, user) {
  const anchors = await getRetentionAnchorsForUsers([{ _id: userId, createdAt: user && user.createdAt }]);
  return anchors.get(String(userId)) || null;
}

/**
 * Records DAY_N_ACTIVE the first time real learner activity (lesson
 * completion or a speaking attempt - never background cron delivery) occurs
 * on or after day N, measured from the same getRetentionAnchor used by the
 * retention analytics endpoint. Safe to call on every activity: already-
 * recorded days are silently skipped by the unique index.
 */
async function recordDayActiveMilestones(user, now = new Date()) {
  const activatedAt = await getRetentionAnchor(user._id, user);
  if (!activatedAt) return;
  const daysSinceActivation = Math.floor((now - activatedAt) / ONE_DAY_MS);
  for (const day of DAY_MILESTONES) {
    if (daysSinceActivation >= day) {
      await recordLearnerEvent(user._id, `DAY_${day}_ACTIVE`, { dedupeKey: `day-${day}` });
    }
  }
}

// ============================================================================
// SHARED FILTER HELPERS
// ============================================================================

async function buildUserMatch({ from, to, level, learningGoal, planDuration } = {}) {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }
  if (level) match.level = level;
  if (learningGoal) match.learningGoal = learningGoal;
  if (planDuration) {
    const ids = await getUserIdsForPlanDuration(Number(planDuration));
    match._id = { $in: ids };
  }
  return match;
}

/** Latest successful payment's planDuration per user - derived, not stored on User. */
async function getUserIdsForPlanDuration(planDuration) {
  const rows = await PaymentHistory.aggregate([
    { $match: { paymentStatus: 'success' } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$userId', planDuration: { $first: '$planDuration' } } },
    { $match: { planDuration } }
  ]);
  return rows.map(r => r._id);
}

/** Latest successful payment (planDuration, paymentId, date) per user, for a bounded set of userIds. */
async function getLatestPaymentInfoMap(userIds) {
  if (!userIds || userIds.length === 0) return new Map();
  const rows = await PaymentHistory.aggregate([
    { $match: { paymentStatus: 'success', userId: { $in: userIds } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$userId',
        planDuration: { $first: '$planDuration' },
        razorpayPaymentId: { $first: '$razorpayPaymentId' },
        createdAt: { $first: '$createdAt' }
      }
    }
  ]);
  const map = new Map();
  rows.forEach(r => map.set(String(r._id), {
    planDuration: r.planDuration,
    razorpayPaymentId: r.razorpayPaymentId,
    createdAt: r.createdAt
  }));
  return map;
}

function average(arr) {
  return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

// ============================================================================
// FUNNEL METRICS
// ============================================================================

async function calculateTimeToMilestoneHours(userIds) {
  if (!userIds.length) return {};
  const users = await User.find({ _id: { $in: userIds } }).select('_id createdAt').lean();
  const activatedAtMap = new Map(users.map(u => [String(u._id), u.createdAt]));

  const types = ['ONBOARDING_COMPLETED', 'FIRST_START', 'FIRST_LESSON_COMPLETED', 'FIRST_VOICE_ATTEMPT'];
  const events = await LearnerEvent.find({ userId: { $in: userIds }, type: { $in: types } })
    .select('userId type occurredAt').lean();

  const result = {};
  types.forEach(type => {
    const diffsHours = events
      .filter(e => e.type === type)
      .map(e => {
        const activatedAt = activatedAtMap.get(String(e.userId));
        return activatedAt ? (new Date(e.occurredAt) - new Date(activatedAt)) / (60 * 60 * 1000) : null;
      })
      .filter(v => v !== null && v >= 0);

    result[type] = {
      sampleSize: diffsHours.length,
      medianHours: median(diffsHours),
      averageHours: average(diffsHours)
    };
  });
  return result;
}

async function calculateFunnelMetrics(filters = {}) {
  const match = await buildUserMatch(filters);
  const totalPaidUsers = await User.countDocuments(match);
  const eligibleIds = (await User.find(match).select('_id').lean()).map(u => u._id);

  // Onboarding funnel only applies to users who actually went through the new
  // onboarding flow (onboardingStatus set) - legacy users predate it entirely.
  const onboardingApplicable = await User.countDocuments({ ...match, onboardingStatus: { $exists: true } });
  const onboardingCompleted = await User.countDocuments({ ...match, onboardingStatus: 'COMPLETED' });

  const countEvent = (type) => LearnerEvent.countDocuments({ userId: { $in: eligibleIds }, type });
  const [firstStart, firstLessonSent, firstLessonCompleted, firstVoiceAttempt] = await Promise.all([
    countEvent('FIRST_START'),
    countEvent('FIRST_LESSON_SENT'),
    countEvent('FIRST_LESSON_COMPLETED'),
    countEvent('FIRST_VOICE_ATTEMPT')
  ]);

  return {
    totalPaidUsers,
    onboarding: {
      applicable: onboardingApplicable,
      completed: onboardingCompleted,
      completionRate: percent(onboardingCompleted, onboardingApplicable)
    },
    firstStart: { count: firstStart, rate: percent(firstStart, totalPaidUsers) },
    firstLessonSent: { count: firstLessonSent, rate: percent(firstLessonSent, totalPaidUsers) },
    firstLessonCompleted: { count: firstLessonCompleted, rate: percent(firstLessonCompleted, totalPaidUsers) },
    firstVoiceAttempt: { count: firstVoiceAttempt, rate: percent(firstVoiceAttempt, totalPaidUsers) },
    timeToMilestoneHours: await calculateTimeToMilestoneHours(eligibleIds)
  };
}

// ============================================================================
// RETENTION METRICS - denominator only ever includes users old enough to
// have reached the milestone day; numerator is real activity (DAY_N_ACTIVE),
// never background cron delivery.
// ============================================================================

async function calculateRetentionMetrics(filters = {}) {
  // from/to/level/learningGoal/planDuration cohort filters still apply as
  // before; the "old enough to have reached day N" check below uses the true
  // retention anchor (SUBSCRIPTION_ACTIVATED -> earliest payment -> createdAt)
  // instead of raw User.createdAt.
  const baseMatch = await buildUserMatch(filters);
  const candidates = await User.find(baseMatch).select('_id createdAt').lean();
  const anchorMap = await getRetentionAnchorsForUsers(candidates);

  const results = {};
  const now = Date.now();

  for (const days of RETENTION_DAYS) {
    const cutoff = now - days * ONE_DAY_MS;
    const cohortIds = candidates
      .filter(u => {
        const anchor = anchorMap.get(String(u._id));
        return anchor && anchor.getTime() <= cutoff;
      })
      .map(u => u._id);

    const retainedCount = cohortIds.length
      ? await LearnerEvent.countDocuments({ userId: { $in: cohortIds }, type: `DAY_${days}_ACTIVE` })
      : 0;

    results[`D${days}`] = {
      cohortSize: cohortIds.length,
      retainedCount,
      retentionRate: percent(retainedCount, cohortIds.length)
    };
  }

  return results;
}

// ============================================================================
// ENGAGEMENT METRICS
// ============================================================================

const LEVEL_ORDER = { beginner: 0, intermediate: 1, advanced: 2 };

async function calculateEngagementMetrics(filters = {}) {
  const match = await buildUserMatch(filters);
  const users = await User.find(match)
    .select('_id streak currentDay isActive learningGoal level assessedLevel onboardingStatus')
    .lean();
  const userIds = users.map(u => u._id);
  const activeUsers = users.filter(u => u.isActive);

  const totalPaidUsers = users.length;
  const activeSubscriptions = activeUsers.length;

  const lessonsCompleted = await Lesson.countDocuments({ userId: { $in: userIds }, status: 'completed' });
  const avgLessonsPerActiveUser = activeSubscriptions ? Math.round((lessonsCompleted / activeSubscriptions) * 10) / 10 : 0;

  const usersWithVoiceAttempt = (await SpeakingAttempt.distinct('userId', { userId: { $in: userIds } })).length;
  const totalSpeakingAttempts = await SpeakingAttempt.countDocuments({ userId: { $in: userIds } });

  const avgScoreResult = await SpeakingAttempt.aggregate([
    { $match: { userId: { $in: userIds }, 'scores.overall': { $ne: null } } },
    { $group: { _id: null, avg: { $avg: '$scores.overall' } } }
  ]);
  const avgOverallSpeakingScore = avgScoreResult[0] ? Math.round(avgScoreResult[0].avg * 10) / 10 : null;

  const streakGte3 = activeUsers.filter(u => u.streak >= 3).length;
  const streakGte7 = activeUsers.filter(u => u.streak >= 7).length;
  const avgDaysCompleted = activeUsers.length
    ? Math.round((activeUsers.reduce((sum, u) => sum + Math.max(0, (u.currentDay || 1) - 1), 0) / activeUsers.length) * 10) / 10
    : 0;

  const onboardingApplicable = users.filter(u => u.onboardingStatus).length;
  const onboardingCompleted = users.filter(u => u.onboardingStatus === 'COMPLETED').length;

  const goalDistribution = {};
  const levelDistribution = {};
  const assessedLevelMismatch = { lower: 0, higher: 0, match: 0, none: 0 };

  users.forEach(u => {
    const goal = u.learningGoal || 'daily_english';
    goalDistribution[goal] = (goalDistribution[goal] || 0) + 1;
    levelDistribution[u.level] = (levelDistribution[u.level] || 0) + 1;

    if (!u.assessedLevel) assessedLevelMismatch.none++;
    else if (u.assessedLevel === u.level) assessedLevelMismatch.match++;
    else if (LEVEL_ORDER[u.assessedLevel] < LEVEL_ORDER[u.level]) assessedLevelMismatch.lower++;
    else assessedLevelMismatch.higher++;
  });

  return {
    totalPaidUsers,
    activeSubscriptions,
    lessonsCompleted,
    avgLessonsPerActiveUser,
    speakingAdoptionRate: percent(usersWithVoiceAttempt, totalPaidUsers),
    avgSpeakingAttemptsPerUser: totalPaidUsers ? Math.round((totalSpeakingAttempts / totalPaidUsers) * 10) / 10 : 0,
    avgOverallSpeakingScore,
    streakDistribution: { gte3: streakGte3, gte7: streakGte7 },
    avgDaysCompleted,
    onboarding: {
      applicable: onboardingApplicable,
      completed: onboardingCompleted,
      completionRate: percent(onboardingCompleted, onboardingApplicable)
    },
    goalDistribution,
    levelDistribution,
    assessedLevelMismatch
  };
}

// ============================================================================
// SUBSCRIPTION SIGNALS
// ============================================================================

async function calculateSubscriptionSignals(filters = {}) {
  const match = await buildUserMatch(filters);
  const now = new Date();
  const expiringSoonCutoff = new Date(now.getTime() + 7 * ONE_DAY_MS);

  const [active, expiringSoon, expired] = await Promise.all([
    User.countDocuments({ ...match, isActive: true, $or: [{ expiryDate: null }, { expiryDate: { $gte: now } }] }),
    User.countDocuments({ ...match, isActive: true, expiryDate: { $gte: now, $lte: expiringSoonCutoff } }),
    User.countDocuments({ ...match, isActive: false })
  ]);

  const eligibleIds = (await User.find(match).select('_id').lean()).map(u => u._id);
  const [renewed, upgraded] = await Promise.all([
    LearnerEvent.countDocuments({ userId: { $in: eligibleIds }, type: 'SUBSCRIPTION_RENEWED' }),
    LearnerEvent.countDocuments({ userId: { $in: eligibleIds }, type: 'SUBSCRIPTION_UPGRADED' })
  ]);

  const planDistributionRows = await PaymentHistory.aggregate([
    { $match: { paymentStatus: 'success', userId: { $in: eligibleIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$userId', planDuration: { $first: '$planDuration' } } },
    { $group: { _id: '$planDuration', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  return {
    active,
    expiringSoon,
    expired,
    renewed,
    upgraded,
    planDurationDistribution: planDistributionRows.map(r => ({ planDuration: r._id, count: r.count }))
  };
}

// ============================================================================
// WEEKLY PROGRESS (deterministic - no AI)
// ============================================================================

async function getWeeklyActivityStats(userId, sinceDate) {
  const [lessonsCompleted, attempts] = await Promise.all([
    Lesson.countDocuments({ userId, status: 'completed', completedAt: { $gte: sinceDate } }),
    SpeakingAttempt.find({ userId, createdAt: { $gte: sinceDate } }).select('scores.overall').lean()
  ]);
  const scores = attempts.map(a => a.scores && a.scores.overall).filter(s => typeof s === 'number');
  const avgSpeakingScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  return { lessonsCompleted, speakingAttemptsCount: attempts.length, avgSpeakingScore };
}

function hadWeeklyActivity(stats) {
  return stats.lessonsCompleted > 0 || stats.speakingAttemptsCount > 0;
}

function buildWeeklyProgressMessage(user, stats, weakAreas = []) {
  const scoreLine = stats.avgSpeakingScore != null ? `\n🎤 Avg speaking score: ${stats.avgSpeakingScore}/10` : '';
  const focusLine = weakAreas.length ? `\n🎯 Focus this week: ${weakAreas.slice(0, 2).map(w => w.replace(/_/g, ' ')).join(', ')}` : '';

  return `📊 Weekly Progress

Hi ${user.name},

✅ Lessons completed: ${stats.lessonsCompleted}
🎤 Speaking practices: ${stats.speakingAttemptsCount}
🔥 Current streak: ${user.streak} day${user.streak !== 1 ? 's' : ''}${scoreLine}${focusLine}

Keep the momentum going next week!`;
}

// ============================================================================
// DAY-30 PROGRESS REPORT (deterministic - no AI)
// ============================================================================

async function buildDay30ProgressReport(user) {
  const [lessonsCompleted, attempts, tutorMemory] = await Promise.all([
    Lesson.countDocuments({ userId: user._id, status: 'completed' }),
    SpeakingAttempt.find({ userId: user._id }).sort({ createdAt: 1 }).select('scores.overall').lean(),
    TutorMemory.findOne({ userId: user._id }).lean()
  ]);

  const validScores = attempts.map(a => a.scores && a.scores.overall).filter(s => typeof s === 'number');

  // Only claim an improvement when there's enough history AND it's real -
  // never fabricate progress the stored data doesn't support.
  let scoreLine = null;
  if (validScores.length >= 3) {
    const first = validScores[0];
    const latest = validScores[validScores.length - 1];
    if (latest > first) scoreLine = `📈 Speaking score: ${first} → ${latest}`;
  }
  const latestScore = validScores.length ? validScores[validScores.length - 1] : null;
  const weakAreas = (tutorMemory && tutorMemory.weakAreas) ? tutorMemory.weakAreas.slice(-3) : [];
  const goalLabel = GOAL_LABELS[user.learningGoal] || GOAL_LABELS.daily_english;

  const lines = [
    "🎉 Your 30-Day FluencyLoop Progress",
    "",
    `✅ Lessons completed: ${lessonsCompleted}/30`,
    `🎤 Speaking practices: ${attempts.length}`,
    `🔥 Current streak: ${user.streak} day${user.streak !== 1 ? 's' : ''}`
  ];
  if (scoreLine) {
    lines.push(scoreLine);
  } else if (latestScore != null) {
    lines.push(`🎤 Latest speaking score: ${latestScore}/10`);
  }
  lines.push(`🎯 Goal: ${goalLabel}`);
  if (weakAreas.length) {
    lines.push('', 'Keep working on:', ...weakAreas.map(w => `• ${w.replace(/_/g, ' ')}`));
  }
  lines.push('', "You've built real momentum. Keep going to make speaking feel more automatic.");

  return lines.join('\n');
}

// ============================================================================
// COMEBACK ENGINE - segmentation, cooldown, deterministic messages
// ============================================================================

const COMEBACK_COOLDOWN_HOURS = 20;

/**
 * Only users who are: active subscribers, past onboarding, and cleanly in
 * 'READY' (their last interaction finished normally and a new day is due but
 * they haven't engaged). Users stuck in WAITING_START are already covered by
 * the existing noon/evening lessonReminder crons - deliberately not duplicated
 * here to avoid stacking two nudges for the same stall.
 */
function isEligibleForComeback(user) {
  if (!user.isActive) return false;
  if (user.expiryDate && new Date(user.expiryDate) < new Date()) return false;
  if (user.state !== 'READY') return false;
  if (user.onboardingStatus && user.onboardingStatus !== 'COMPLETED') return false;
  return true;
}

function getComebackSegment(user, now = new Date()) {
  if (!isEligibleForComeback(user)) return null;
  const lastActivity = user.lastLessonCompletedDate || user.createdAt;
  if (!lastActivity) return null;

  const missedDays = Math.floor((now - new Date(lastActivity)) / ONE_DAY_MS);
  if (missedDays >= 7) return 'week';
  if (missedDays >= 3) return 'few_days';
  if (missedDays >= 1) return 'yesterday';
  return null;
}

const COMEBACK_MESSAGES = {
  yesterday: (user) => `You missed yesterday's lesson, ${user.name} — no problem!\n\nReply START and continue from where you stopped.`,
  few_days: () => `Your streak paused, but your progress is still saved.\n\nA 10-minute lesson today is enough to restart.\n\nReply START.`,
  week: () => `It's been a week since your last practice.\n\nYour FluencyLoop progress is still waiting for you.\n\nReply START to continue.`
};

function buildComebackMessage(segment, user) {
  const builder = COMEBACK_MESSAGES[segment];
  return builder ? builder(user) : null;
}

async function canSendComebackReminder(userId) {
  const last = await LearnerEvent.findOne({ userId, type: 'COMEBACK_REMINDER_SENT' }).sort({ occurredAt: -1 }).lean();
  if (!last) return true;
  const hoursSince = (Date.now() - new Date(last.occurredAt).getTime()) / (60 * 60 * 1000);
  return hoursSince >= COMEBACK_COOLDOWN_HOURS;
}

// ============================================================================
// 30->90 UPGRADE ENGINE - deterministic eligibility, no AI, drives to UPGRADE
// (never generates its own payment link - that stays owned by the existing
// UPGRADE flow in webhookController.js/paymentController.js).
// ============================================================================

const UPGRADE_WINDOW_DAYS = [25, 30];
const UPGRADE_MIN_LESSONS = 10;
const UPGRADE_MIN_STREAK = 5;
const UPGRADE_MIN_VOICE_ATTEMPTS = 5;
const UPGRADE_NUDGE_COOLDOWN_DAYS = 5;

function isWithinUpgradeWindow(planDuration, daysSincePayment) {
  return planDuration === 30 && daysSincePayment >= UPGRADE_WINDOW_DAYS[0] && daysSincePayment <= UPGRADE_WINDOW_DAYS[1];
}

function isEngagedEnoughForUpgrade(user, { lessonsCompleted, speakingAttempts }) {
  return lessonsCompleted >= UPGRADE_MIN_LESSONS
    || (user.streak || 0) >= UPGRADE_MIN_STREAK
    || speakingAttempts >= UPGRADE_MIN_VOICE_ATTEMPTS;
}

/** True/false/'disengaged' - callers branch on the exact string. */
function getUpgradeSegment(user, { planDuration, daysSincePayment, lessonsCompleted, speakingAttempts }) {
  if (!user.isActive) return null;
  if (user.onboardingStatus && user.onboardingStatus !== 'COMPLETED') return null;
  if (!isWithinUpgradeWindow(planDuration, daysSincePayment)) return null;

  return isEngagedEnoughForUpgrade(user, { lessonsCompleted, speakingAttempts }) ? 'engaged' : 'disengaged';
}

function buildUpgradeNudgeMessage(user, { lessonsCompleted, speakingAttempts }) {
  const goalLabel = (GOAL_LABELS[user.learningGoal] || GOAL_LABELS.daily_english).toLowerCase();
  return `You've completed ${lessonsCompleted} lessons and practiced speaking ${speakingAttempts} times.

Your first 30 days built the foundation.

Continue for 90 days to strengthen your ${goalLabel} skills and speaking consistency.

Reply UPGRADE to view your options.`;
}

function buildDisengagedNudgeMessage() {
  return `You still have lessons available, and your progress is saved.

Reply START to continue before your plan ends.`;
}

async function canSendUpgradeNudge(userId) {
  const last = await LearnerEvent.findOne({ userId, type: 'UPGRADE_NUDGE_SENT' }).sort({ occurredAt: -1 }).lean();
  if (!last) return true;
  const daysSince = (Date.now() - new Date(last.occurredAt).getTime()) / ONE_DAY_MS;
  return daysSince >= UPGRADE_NUDGE_COOLDOWN_DAYS;
}

module.exports = {
  recordLearnerEvent,
  recordDayActiveMilestones,
  getActivationDate,
  getRetentionAnchor,
  getRetentionAnchorsForUsers,
  buildUserMatch,
  getUserIdsForPlanDuration,
  getLatestPaymentInfoMap,
  calculateFunnelMetrics,
  calculateRetentionMetrics,
  calculateEngagementMetrics,
  calculateSubscriptionSignals,
  getWeeklyActivityStats,
  hadWeeklyActivity,
  buildWeeklyProgressMessage,
  buildDay30ProgressReport,
  isEligibleForComeback,
  getComebackSegment,
  buildComebackMessage,
  canSendComebackReminder,
  isWithinUpgradeWindow,
  isEngagedEnoughForUpgrade,
  getUpgradeSegment,
  buildUpgradeNudgeMessage,
  buildDisengagedNudgeMessage,
  canSendUpgradeNudge,
  RETENTION_DAYS,
  DAY_MILESTONES
};
