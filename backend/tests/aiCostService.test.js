const { resolveRange, fillDaily, buildForecast, computeLearnerDays } = require('../services/aiCostService');

// 2026-11-01 01:00 IST = 2026-10-31 19:30 UTC - an IST-vs-UTC date boundary case.
const NOW = new Date('2026-10-31T19:30:00.000Z');

describe('resolveRange (IST calendar, exclusive end)', () => {
  test('today uses the IST date, not the UTC date', () => {
    const r = resolveRange({ preset: 'today' }, NOW);
    expect(r.fromDate).toBe('2026-11-01');
    expect(r.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(r.days).toBe(1);
  });

  test('week is the last 7 IST days including today', () => {
    const r = resolveRange({ preset: 'week' }, NOW);
    expect([r.fromDate, r.toDate, r.days]).toEqual(['2026-10-26', '2026-11-01', 7]);
  });

  test('month is the current IST calendar month to date', () => {
    const r = resolveRange({ preset: 'month' }, NOW);
    expect([r.fromDate, r.toDate, r.days]).toEqual(['2026-11-01', '2026-11-01', 1]);
  });

  test('custom range includes the "to" date via an exclusive end at the next IST midnight', () => {
    const r = resolveRange({ from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(r.preset).toBe('custom');
    expect(r.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(r.days).toBe(31);
    expect(r.includesToday).toBe(false);
  });

  test('rejects invalid input', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW).error).toBeDefined();
    expect(resolveRange({ preset: 'custom', from: '2026-03-02', to: '2026-03-01' }, NOW).error).toBeDefined();
    expect(resolveRange({ preset: 'year' }, NOW).error).toBeDefined();
    expect(resolveRange({ from: '2026-13-01', to: '2026-13-05' }, NOW).error).toBeDefined(); // Invalid Date, must not throw
    expect(resolveRange({ from: '2026-00-10', to: '2026-01-10' }, NOW).error).toBeDefined();
    expect(resolveRange({ from: '2026-04-31', to: '2026-05-01' }, NOW).error).toBeDefined();
    expect(resolveRange({ from: ['2026-01-01'], to: '2026-01-02' }, NOW).error).toBeDefined();
    expect(resolveRange({ from: '2024-01-01', to: '2026-01-01' }, NOW).error).toMatch(/exceed/);
  });
});

test('fillDaily returns every date in range with zero for days without usage', () => {
  const range = resolveRange({ from: '2026-10-01', to: '2026-10-03' }, NOW);
  const daily = fillDaily(range, [{ _id: '2026-10-02', costUsd: 0.5, requests: 3, unknownCostRequests: 1 }]);
  expect(daily).toEqual([
    { date: '2026-10-01', costUsd: 0, requests: 0, unknownCostRequests: 0 },
    { date: '2026-10-02', costUsd: 0.5, requests: 3, unknownCostRequests: 1 },
    { date: '2026-10-03', costUsd: 0, requests: 0, unknownCostRequests: 0 }
  ]);
});

describe('buildForecast', () => {
  const base = {
    days: 10,
    includesToday: false,
    lessonsSent: 400,
    sentLearners: 50,
    learnerDays: 500,
    recurringCostUsd: 5, // 5 / 500 learner-days = $0.01 per learner-day
    onboardingCostUsd: 0.2,
    onboardedUsers: 10,
    unattributedCostUsd: 1,
    unknownCostRequests: 0
  };

  test('scales observed per-learner-day cost to 30 days for each learner count', () => {
    const f = buildForecast(base);
    expect(f.available).toBe(true);
    expect(f.warnings).toEqual([]);
    expect(f.assumptions.perLearner30DayUsd).toBeCloseTo(0.3, 12);
    expect(f.assumptions.lessonsPerLearnerPerDay).toBeCloseTo(0.8, 12);
    const row1000 = f.rows.find(r => r.learners === 1000);
    expect(row1000.recurring30DayUsd).toBeCloseTo(300, 9);
    expect(row1000.oneTimeOnboardingUsd).toBeCloseTo(20, 9);
    expect(row1000.unattributed30DayUsd).toBeCloseTo(3, 12); // fixed, not scaled
    expect(row1000.total30DayUsd).toBeCloseTo(303, 9);
    expect(f.rows.map(r => r.learners)).toEqual([100, 500, 1000, 10000]);
    expect(f.assumptions.notes.join(' ')).toMatch(/excludes WhatsApp, AWS, database and payment/);
  });

  test('warns on small samples, partial days and unknown costs', () => {
    const f = buildForecast({ ...base, days: 3, sentLearners: 5, includesToday: true, unknownCostRequests: 2 });
    expect(f.warnings).toHaveLength(4);
  });

  test('no onboarding usage gives null, not a made-up onboarding cost', () => {
    const f = buildForecast({ ...base, onboardingCostUsd: 0, onboardedUsers: 0 });
    expect(f.rows[0].oneTimeOnboardingUsd).toBeNull();
  });

  test('unavailable when no learner was sent a lesson', () => {
    expect(buildForecast({ ...base, sentLearners: 0, lessonsSent: 0, learnerDays: 0 }).available).toBe(false);
  });

  test('uses enrolled learner-days, not unique learners x calendar days', () => {
    // 2 learners over 10 days, but one joined on day 9 -> 10 + 2 = 12 learner-days, not 20
    const f = buildForecast({ ...base, sentLearners: 2, learnerDays: 12, recurringCostUsd: 0.12 });
    expect(f.assumptions.perLearnerDayUsd).toBeCloseTo(0.01, 12);
  });
});

describe('computeLearnerDays', () => {
  const range = resolveRange({ from: '2026-10-01', to: '2026-10-10' }, NOW);

  test('counts from the first lesson in range to range end or expiry', () => {
    expect(computeLearnerDays([
      { firstSentAt: new Date('2026-10-01T01:30:00.000Z'), expiryDate: null }, // whole range: 10
      { firstSentAt: new Date('2026-10-09T01:30:00.000Z'), expiryDate: null }, // joined day 9: 2
      { firstSentAt: new Date('2026-10-01T01:30:00.000Z'), expiryDate: new Date('2026-10-04T18:30:00.000Z') } // expired end of Oct 4 IST: 4
    ], range)).toBe(16);
  });

  test('a lesson notified before the range is clamped to the range start; minimum one day', () => {
    expect(computeLearnerDays([{ firstSentAt: new Date('2026-09-20T01:30:00.000Z'), expiryDate: null }], range)).toBe(10);
    expect(computeLearnerDays([{ firstSentAt: new Date('2026-10-05T01:30:00.000Z'), expiryDate: new Date('2026-09-01') }], range)).toBe(1);
  });
});

describe('getAiCostReport', () => {
  jest.resetModules();
  jest.doMock('../models/AiUsage', () => ({ aggregate: jest.fn() }));
  jest.doMock('../models/User', () => ({ countDocuments: jest.fn(), find: jest.fn() }));
  jest.doMock('../models/Lesson', () => ({ distinct: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
  jest.doMock('../models/Log', () => ({ countDocuments: jest.fn() }));
  const AiUsage = require('../models/AiUsage');
  const User = require('../models/User');
  const Lesson = require('../models/Lesson');
  const Log = require('../models/Log');
  const svc = require('../services/aiCostService');

  test('separates attributed and unattributed cost and never divides by registered users', async () => {
    const row = (o) => ({ requests: 0, failedRequests: 0, unknownCostRequests: 0, costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: 0, ...o });
    AiUsage.aggregate.mockResolvedValue([{
      totals: [row({ _id: null, requests: 4, costUsd: 0.04, unknownCostRequests: 1 })],
      byOperation: [],
      byModel: [],
      daily: [],
      perUser: [
        row({ _id: 'a', requests: 2, costUsd: 0.02, lessonCostUsd: 0.015, voiceCostUsd: 0.005, onboardingCostUsd: 0 }),
        row({ _id: 'b', requests: 1, costUsd: 0.01, lessonCostUsd: 0.01, voiceCostUsd: 0, onboardingCostUsd: 0 })
      ],
      unattributed: [row({ _id: null, requests: 1, costUsd: 0.01 })]
    }]);
    User.countDocuments.mockResolvedValueOnce(1000).mockResolvedValueOnce(40);
    Lesson.aggregate.mockResolvedValue([{ _id: 'a', lessons: 1, firstSentAt: new Date('2026-10-01T01:30:00.000Z') }]);
    Lesson.distinct.mockResolvedValue(['a']);
    Lesson.countDocuments.mockResolvedValue(2);
    Log.countDocuments.mockResolvedValue(3);
    const lean = (docs) => ({ select: () => ({ lean: () => Promise.resolve(docs) }) });
    User.find
      .mockReturnValueOnce(lean([{ _id: 'a', expiryDate: null }]))
      .mockReturnValueOnce(lean([{ _id: 'a', name: 'Asha', phone: '919876543210' }]));

    const range = svc.resolveRange({ from: '2026-10-01', to: '2026-10-01' }, NOW);
    const report = await svc.getAiCostReport(range, NOW);

    expect(report.users).toEqual({ registered: 1000, activeSubscribed: 40, sentLesson: 1, completedLesson: 1, incurredAiCost: 2 });
    expect(report.unattributed.costUsd).toBeCloseTo(0.01, 12);
    expect(report.averages.costPerUserWithAiUsageUsd).toBeCloseTo(0.015, 12); // 0.03 / 2 users, not / 1000
    expect(report.averages.costPerLearnerSentLessonUsd).toBeCloseTo(0.02, 12); // only user "a"
    expect(report.averages.costPerCompletedLessonUsd).toBeCloseTo(0.02, 12); // 0.04 / 2 lessons
    expect(report.perUser[0]).toMatchObject({ name: 'Asha', phone: '••••3210' });
    expect(report.perUser[1].name).toBe('(deleted user)');
    expect(report.trackingHealth).toMatchObject({ trackingErrorsInRange: 3, unknownCostRequests: 1 });
    expect(report.range.endExclusive).toBe('2026-10-01T18:30:00.000Z');
    expect(report.forecast.assumptions.learnerDays).toBe(1);
    expect(report.forecast.assumptions.perLearnerDayUsd).toBeCloseTo(0.02, 12); // only learner "a"'s lesson + voice cost
  });
});
