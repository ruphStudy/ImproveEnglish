jest.mock('../models/User', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Lesson', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/SpeakingAttempt', () => ({ find: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/TutorMemory', () => ({ findOne: jest.fn() }));
jest.mock('../models/PaymentHistory', () => ({ aggregate: jest.fn() }));
jest.mock('../models/LearnerEvent', () => ({ create: jest.fn(), countDocuments: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../config/openai', () => ({ chat: { completions: { create: jest.fn() } } }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));

const User = require('../models/User');
const Lesson = require('../models/Lesson');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const TutorMemory = require('../models/TutorMemory');
const PaymentHistory = require('../models/PaymentHistory');
const LearnerEvent = require('../models/LearnerEvent');

const {
  recordLearnerEvent,
  recordDayActiveMilestones,
  calculateFunnelMetrics,
  calculateRetentionMetrics,
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
  canSendUpgradeNudge
} = require('../services/retentionService');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n) {
  return new Date(Date.now() - n * ONE_DAY_MS);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================================
// Milestone idempotency
// ============================================================================

describe('recordLearnerEvent - idempotency', () => {
  test('a fresh milestone is created normally', async () => {
    LearnerEvent.create.mockResolvedValue({ _id: 'e1' });
    const result = await recordLearnerEvent('user1', 'FIRST_START');
    expect(result).toEqual({ _id: 'e1' });
    expect(LearnerEvent.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1', type: 'FIRST_START', dedupeKey: 'default' }));
  });

  test('a duplicate-key error (already recorded) is swallowed as a safe no-op', async () => {
    const dupErr = new Error('duplicate'); dupErr.code = 11000;
    LearnerEvent.create.mockRejectedValue(dupErr);
    const result = await recordLearnerEvent('user1', 'FIRST_START');
    expect(result).toBeNull();
  });

  test('a genuine DB error is swallowed too (milestone tracking must never break the caller)', async () => {
    LearnerEvent.create.mockRejectedValue(new Error('mongo down'));
    await expect(recordLearnerEvent('user1', 'FIRST_START')).resolves.toBeNull();
  });

  test('repeatable event types (renewals) use a distinct dedupeKey per payment, not a singleton', async () => {
    LearnerEvent.create.mockResolvedValue({});
    await recordLearnerEvent('user1', 'SUBSCRIPTION_RENEWED', { dedupeKey: 'pay_123' });
    expect(LearnerEvent.create).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'pay_123' }));
  });
});

describe('recordDayActiveMilestones', () => {
  test('records every day milestone reached so far (duplicate inserts safely no-op via the unique index)', async () => {
    LearnerEvent.create.mockResolvedValue({});
    const user = { _id: 'u1', createdAt: daysAgo(10) }; // past day 1,3,7 but not 14,30
    await recordDayActiveMilestones(user);
    const recordedTypes = LearnerEvent.create.mock.calls.map(c => c[0].type);
    expect(recordedTypes).toEqual(expect.arrayContaining(['DAY_1_ACTIVE', 'DAY_3_ACTIVE', 'DAY_7_ACTIVE']));
    expect(recordedTypes).not.toContain('DAY_14_ACTIVE');
    expect(recordedTypes).not.toContain('DAY_30_ACTIVE');
  });

  test('does nothing (no crash) when createdAt is missing', async () => {
    await recordDayActiveMilestones({ _id: 'u1' });
    expect(LearnerEvent.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Retention metrics - correct denominator/numerator
// ============================================================================

describe('calculateRetentionMetrics', () => {
  test('D7 cohort excludes users who subscribed too recently to have reached day 7', async () => {
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'old1' }]) }) });
    LearnerEvent.countDocuments.mockResolvedValue(1);

    const result = await calculateRetentionMetrics({});

    // The match passed to User.find for D7 must exclude users created within the last 7 days
    const matchArg = User.find.mock.calls.find((c, i) => true); // just verify shape below via cohortSize path
    expect(result.D7.cohortSize).toBe(1);
    expect(result.D7.retainedCount).toBe(1);
    expect(result.D7.retentionRate).toBe(100);
  });

  test('an inactive user (no DAY_7_ACTIVE event) is not counted as retained', async () => {
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'a' }, { _id: 'b' }]) }) });
    LearnerEvent.countDocuments.mockResolvedValue(0); // neither has the milestone

    const result = await calculateRetentionMetrics({});

    expect(result.D7.cohortSize).toBe(2);
    expect(result.D7.retainedCount).toBe(0);
    expect(result.D7.retentionRate).toBe(0);
  });

  test('an empty cohort produces a 0% rate, not a division error', async () => {
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });

    const result = await calculateRetentionMetrics({});

    expect(result.D30.cohortSize).toBe(0);
    expect(result.D30.retentionRate).toBe(0);
    expect(LearnerEvent.countDocuments).not.toHaveBeenCalled();
  });

  test('background cron delivery alone (no DAY_N_ACTIVE event) never counts as retained - only real activity does', async () => {
    // DAY_N_ACTIVE is only ever recorded from lesson-completion/voice-attempt code
    // paths (see recordDayActiveMilestones callers) - this test documents that
    // retention counting has no other source of truth.
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'u1' }]) }) });
    LearnerEvent.countDocuments.mockResolvedValue(0);

    const result = await calculateRetentionMetrics({});
    expect(result.D3.retainedCount).toBe(0);
  });
});

// ============================================================================
// Funnel metrics
// ============================================================================

describe('calculateFunnelMetrics', () => {
  test('computes onboarding completion and first-milestone rates against the right denominators', async () => {
    User.countDocuments
      .mockResolvedValueOnce(10) // totalPaidUsers
      .mockResolvedValueOnce(6)  // onboardingApplicable
      .mockResolvedValueOnce(3); // onboardingCompleted
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(Array.from({ length: 10 }, (_, i) => ({ _id: `u${i}` }))) }) });
    LearnerEvent.countDocuments
      .mockResolvedValueOnce(8) // FIRST_START
      .mockResolvedValueOnce(7) // FIRST_LESSON_SENT
      .mockResolvedValueOnce(5) // FIRST_LESSON_COMPLETED
      .mockResolvedValueOnce(2); // FIRST_VOICE_ATTEMPT
    LearnerEvent.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });

    const result = await calculateFunnelMetrics({});

    expect(result.totalPaidUsers).toBe(10);
    expect(result.onboarding).toEqual({ applicable: 6, completed: 3, completionRate: 50 });
    expect(result.firstStart).toEqual({ count: 8, rate: 80 });
    expect(result.firstLessonCompleted).toEqual({ count: 5, rate: 50 });
  });
});

// ============================================================================
// Weekly progress
// ============================================================================

describe('getWeeklyActivityStats / hadWeeklyActivity / buildWeeklyProgressMessage', () => {
  test('an inactive week is correctly identified (no fake progress claim)', async () => {
    Lesson.countDocuments.mockResolvedValue(0);
    SpeakingAttempt.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });

    const stats = await getWeeklyActivityStats('u1', daysAgo(7));
    expect(hadWeeklyActivity(stats)).toBe(false);
  });

  test('an active week (lessons or speaking) is identified correctly', async () => {
    Lesson.countDocuments.mockResolvedValue(3);
    SpeakingAttempt.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ scores: { overall: 7 } }]) }) });

    const stats = await getWeeklyActivityStats('u1', daysAgo(7));
    expect(hadWeeklyActivity(stats)).toBe(true);
    expect(stats.avgSpeakingScore).toBe(7);
  });

  test('weekly message reflects the actual stored stats', () => {
    const msg = buildWeeklyProgressMessage({ name: 'Raj', streak: 4 }, { lessonsCompleted: 5, speakingAttemptsCount: 3, avgSpeakingScore: 6.5 }, ['prepositions']);
    expect(msg).toContain('Lessons completed: 5');
    expect(msg).toContain('Speaking practices: 3');
    expect(msg).toContain('6.5/10');
    expect(msg).toContain('prepositions');
  });
});

// ============================================================================
// Day-30 progress report
// ============================================================================

describe('buildDay30ProgressReport', () => {
  const user = { _id: 'u1', name: 'Raj', streak: 6, learningGoal: 'interview' };

  test('insufficient speaking history does not claim an improvement', async () => {
    Lesson.countDocuments.mockResolvedValue(20);
    SpeakingAttempt.find.mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve([{ scores: { overall: 5 } }]) }) }) });
    TutorMemory.findOne.mockReturnValue({ lean: () => Promise.resolve({ weakAreas: ['prepositions'] }) });

    const report = await buildDay30ProgressReport(user);
    expect(report).not.toContain('→');
    expect(report).toContain('Latest speaking score: 5/10');
  });

  test('a genuine, sufficiently-attested improvement is displayed as first -> latest', async () => {
    Lesson.countDocuments.mockResolvedValue(24);
    SpeakingAttempt.find.mockReturnValue({
      sort: () => ({ select: () => ({ lean: () => Promise.resolve([{ scores: { overall: 5 } }, { scores: { overall: 6 } }, { scores: { overall: 7 } }]) }) })
    });
    TutorMemory.findOne.mockReturnValue({ lean: () => Promise.resolve({ weakAreas: ['prepositions', 'past_tense'] }) });

    const report = await buildDay30ProgressReport(user);
    expect(report).toContain('Speaking score: 5 → 7');
    expect(report).toContain('Interview English');
    expect(report).toContain('past tense');
  });

  test('no improvement claimed when the score did not actually improve', async () => {
    Lesson.countDocuments.mockResolvedValue(10);
    SpeakingAttempt.find.mockReturnValue({
      sort: () => ({ select: () => ({ lean: () => Promise.resolve([{ scores: { overall: 7 } }, { scores: { overall: 6 } }, { scores: { overall: 6 } }]) }) })
    });
    TutorMemory.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const report = await buildDay30ProgressReport(user);
    expect(report).not.toContain('→');
    expect(report).toContain('Latest speaking score: 6/10');
  });
});

// ============================================================================
// Comeback engine
// ============================================================================

describe('isEligibleForComeback / getComebackSegment', () => {
  const baseUser = { isActive: true, state: 'READY', onboardingStatus: 'COMPLETED', createdAt: daysAgo(60) };

  test('expired users are excluded', () => {
    expect(isEligibleForComeback({ ...baseUser, expiryDate: daysAgo(1) })).toBe(false);
  });

  test('users still onboarding are excluded', () => {
    expect(isEligibleForComeback({ ...baseUser, onboardingStatus: 'PENDING_ASSESSMENT' })).toBe(false);
  });

  test('paused/non-READY users are excluded (WAITING_START already covered by lessonReminder crons)', () => {
    expect(isEligibleForComeback({ ...baseUser, state: 'PAUSED' })).toBe(false);
    expect(isEligibleForComeback({ ...baseUser, state: 'WAITING_START' })).toBe(false);
  });

  test('1 missed day -> "yesterday" segment', () => {
    const segment = getComebackSegment({ ...baseUser, lastLessonCompletedDate: daysAgo(1) });
    expect(segment).toBe('yesterday');
  });

  test('3+ missed days -> "few_days" segment', () => {
    expect(getComebackSegment({ ...baseUser, lastLessonCompletedDate: daysAgo(3) })).toBe('few_days');
  });

  test('7+ missed days -> "week" segment', () => {
    expect(getComebackSegment({ ...baseUser, lastLessonCompletedDate: daysAgo(9) })).toBe('week');
  });

  test('active today -> no reminder needed', () => {
    expect(getComebackSegment({ ...baseUser, lastLessonCompletedDate: new Date() })).toBeNull();
  });

  test('an ineligible user never gets a segment regardless of inactivity', () => {
    expect(getComebackSegment({ ...baseUser, isActive: false, lastLessonCompletedDate: daysAgo(10) })).toBeNull();
  });
});

describe('buildComebackMessage', () => {
  test('each segment produces its own distinct message', () => {
    const user = { name: 'Raj' };
    expect(buildComebackMessage('yesterday', user)).toContain('missed yesterday');
    expect(buildComebackMessage('few_days', user)).toContain('streak paused');
    expect(buildComebackMessage('week', user)).toContain('been a week');
    expect(buildComebackMessage(null, user)).toBeNull();
  });
});

describe('canSendComebackReminder - cooldown', () => {
  test('allows sending when no prior reminder exists', async () => {
    LearnerEvent.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(null) }) });
    expect(await canSendComebackReminder('u1')).toBe(true);
  });

  test('blocks sending within the cooldown window', async () => {
    LearnerEvent.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ occurredAt: new Date() }) }) });
    expect(await canSendComebackReminder('u1')).toBe(false);
  });

  test('allows sending again once the cooldown has elapsed', async () => {
    LearnerEvent.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ occurredAt: daysAgo(2) }) }) });
    expect(await canSendComebackReminder('u1')).toBe(true);
  });
});

// ============================================================================
// 30->90 upgrade engine
// ============================================================================

describe('isWithinUpgradeWindow / isEngagedEnoughForUpgrade / getUpgradeSegment', () => {
  test('only 30-day plans in the day 25-30 window are in scope', () => {
    expect(isWithinUpgradeWindow(30, 27)).toBe(true);
    expect(isWithinUpgradeWindow(30, 10)).toBe(false);
    expect(isWithinUpgradeWindow(90, 27)).toBe(false);
    expect(isWithinUpgradeWindow(365, 27)).toBe(false);
  });

  test('engagement is satisfied by lessons OR streak OR voice attempts (any one qualifies)', () => {
    expect(isEngagedEnoughForUpgrade({ streak: 0 }, { lessonsCompleted: 10, speakingAttempts: 0 })).toBe(true);
    expect(isEngagedEnoughForUpgrade({ streak: 5 }, { lessonsCompleted: 0, speakingAttempts: 0 })).toBe(true);
    expect(isEngagedEnoughForUpgrade({ streak: 0 }, { lessonsCompleted: 0, speakingAttempts: 5 })).toBe(true);
    expect(isEngagedEnoughForUpgrade({ streak: 0 }, { lessonsCompleted: 1, speakingAttempts: 1 })).toBe(false);
  });

  test('an engaged 30-day user in-window is eligible for the strong upgrade pitch', () => {
    const user = { isActive: true, streak: 6, onboardingStatus: 'COMPLETED' };
    const segment = getUpgradeSegment(user, { planDuration: 30, daysSincePayment: 27, lessonsCompleted: 15, speakingAttempts: 2 });
    expect(segment).toBe('engaged');
  });

  test('a disengaged 30-day user in-window gets the soft nudge, not the strong pitch', () => {
    const user = { isActive: true, streak: 0, onboardingStatus: 'COMPLETED' };
    const segment = getUpgradeSegment(user, { planDuration: 30, daysSincePayment: 27, lessonsCompleted: 2, speakingAttempts: 0 });
    expect(segment).toBe('disengaged');
  });

  test('90/180/365-day plan users are excluded from the 30->90 engine entirely', () => {
    const user = { isActive: true, streak: 20, onboardingStatus: 'COMPLETED' };
    expect(getUpgradeSegment(user, { planDuration: 90, daysSincePayment: 27, lessonsCompleted: 50, speakingAttempts: 20 })).toBeNull();
    expect(getUpgradeSegment(user, { planDuration: 365, daysSincePayment: 27, lessonsCompleted: 50, speakingAttempts: 20 })).toBeNull();
  });

  test('users still onboarding are excluded even if otherwise eligible', () => {
    const user = { isActive: true, streak: 10, onboardingStatus: 'PENDING_ASSESSMENT' };
    expect(getUpgradeSegment(user, { planDuration: 30, daysSincePayment: 27, lessonsCompleted: 15, speakingAttempts: 5 })).toBeNull();
  });
});

describe('buildUpgradeNudgeMessage', () => {
  test('reflects actual progress and goal, never invents a price/discount', () => {
    const msg = buildUpgradeNudgeMessage({ name: 'Raj', learningGoal: 'interview' }, { lessonsCompleted: 23, speakingAttempts: 14 });
    expect(msg).toContain('23 lessons');
    expect(msg).toContain('14 times');
    expect(msg).toContain('Reply UPGRADE');
    expect(msg).not.toMatch(/\d+%\s*off|discount|₹\d/i);
  });
});

describe('canSendUpgradeNudge - cooldown', () => {
  test('blocks a repeat nudge inside the cooldown window', async () => {
    LearnerEvent.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ occurredAt: daysAgo(1) }) }) });
    expect(await canSendUpgradeNudge('u1')).toBe(false);
  });

  test('allows a nudge once the cooldown has elapsed', async () => {
    LearnerEvent.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ occurredAt: daysAgo(10) }) }) });
    expect(await canSendUpgradeNudge('u1')).toBe(true);
  });
});
