jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../models/Lesson', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/SpeakingAttempt', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/LearnerEvent', () => ({ exists: jest.fn() }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/whatsappService', () => ({ sendWhatsAppMessage: jest.fn().mockResolvedValue({}) }));
jest.mock('../utils/cronLock', () => ({
  runWithCronLock: jest.fn((key, ttl, fn) => fn())
}));
jest.mock('../services/retentionService', () => ({
  recordLearnerEvent: jest.fn().mockResolvedValue({ _id: 'evt1' }),
  getLatestPaymentInfoMap: jest.fn(),
  getComebackSegment: jest.fn(),
  buildComebackMessage: jest.fn().mockReturnValue('COMEBACK_MSG'),
  canSendComebackReminder: jest.fn().mockResolvedValue(true),
  isWithinUpgradeWindow: jest.fn(),
  isEngagedEnoughForUpgrade: jest.fn(),
  getUpgradeSegment: jest.fn(),
  buildUpgradeNudgeMessage: jest.fn().mockReturnValue('UPGRADE_MSG'),
  buildDisengagedNudgeMessage: jest.fn().mockReturnValue('DISENGAGED_MSG'),
  canSendUpgradeNudge: jest.fn().mockResolvedValue(true),
  buildDay30ProgressReport: jest.fn().mockResolvedValue('DAY30_REPORT')
}));

const User = require('../models/User');
const Lesson = require('../models/Lesson');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const LearnerEvent = require('../models/LearnerEvent');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const {
  recordLearnerEvent,
  getLatestPaymentInfoMap,
  getComebackSegment,
  canSendComebackReminder,
  isWithinUpgradeWindow,
  getUpgradeSegment,
  canSendUpgradeNudge
} = require('../services/retentionService');

const { runRetentionEngineJob } = require('../cron/retentionEngine');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n) { return new Date(Date.now() - n * ONE_DAY_MS); }

function makeUser(overrides = {}) {
  return { _id: 'u1', phone: '919000000001', name: 'Raj', streak: 0, isActive: true, state: 'READY', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  recordLearnerEvent.mockResolvedValue({ _id: 'evt1' });
  canSendComebackReminder.mockResolvedValue(true);
  canSendUpgradeNudge.mockResolvedValue(true);
  getComebackSegment.mockReturnValue(null);
  getUpgradeSegment.mockReturnValue(null);
  isWithinUpgradeWindow.mockReturnValue(false);
  getLatestPaymentInfoMap.mockResolvedValue(new Map());
  Lesson.countDocuments.mockResolvedValue(0);
  SpeakingAttempt.countDocuments.mockResolvedValue(0);
  LearnerEvent.exists.mockResolvedValue(null); // Day-30 report not yet sent for this cycle
});

describe('runRetentionEngineJob - priority ordering (at most one message per user per run)', () => {
  test('a Day-30-eligible user gets the progress report and NOT also a comeback/upgrade message', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    getComebackSegment.mockReturnValue('yesterday'); // would otherwise also fire

    const result = await runRetentionEngineJob();

    expect(recordLearnerEvent).toHaveBeenCalledWith(user._id, 'DAY30_REPORT_SENT', { dedupeKey: 'pay_1' });
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(user.phone, 'DAY30_REPORT');
    expect(result.day30Sent).toBe(1);
    expect(result.comebackSent).toBe(0);
  });

  test('a Day-30 report already sent for this payment cycle is not sent again', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    LearnerEvent.exists.mockResolvedValue({ _id: 'evt1' }); // already recorded for this payment cycle

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(recordLearnerEvent).not.toHaveBeenCalledWith(user._id, 'DAY30_REPORT_SENT', expect.anything());
    expect(result.day30Sent).toBe(0);
  });

  test('a Day-30 report send failure (e.g. outside the 24h window) leaves the milestone unclaimed for retry', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    sendWhatsAppMessage.mockRejectedValueOnce(new Error('outside window'));

    const result = await runRetentionEngineJob();

    expect(recordLearnerEvent).not.toHaveBeenCalledWith(user._id, 'DAY30_REPORT_SENT', expect.anything());
    expect(result.day30Sent).toBe(0);
    expect(result.errors).toBe(1);
  });
});

describe('runRetentionEngineJob - upgrade engine', () => {
  // The Day-30 report and upgrade windows overlap by design (both cover a
  // 30-day-plan user's final days) - Day-30 report has priority per user per
  // run. To exercise the upgrade branch in isolation, simulate "this cycle's
  // Day-30 report was already sent" so the code proceeds past it - exactly
  // what happens on the days following the (once-per-cycle) report.
  function alreadySentDay30() {
    LearnerEvent.exists.mockResolvedValue({ _id: 'evt1' }); // Day-30 report already claimed this cycle
  }

  test('an engaged user gets the strong upgrade pitch', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    isWithinUpgradeWindow.mockReturnValue(true);
    getUpgradeSegment.mockReturnValue('engaged');
    alreadySentDay30();

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(user.phone, 'UPGRADE_MSG');
    expect(result.upgradeSent).toBe(1);
    expect(result.disengagedSent).toBe(0);
  });

  test('a disengaged user gets the soft nudge, not the strong upgrade pitch', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    isWithinUpgradeWindow.mockReturnValue(true);
    getUpgradeSegment.mockReturnValue('disengaged');
    alreadySentDay30();

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(user.phone, 'DISENGAGED_MSG');
    expect(result.disengagedSent).toBe(1);
    expect(result.upgradeSent).toBe(0);
  });

  test('upgrade nudge cooldown prevents a repeat send', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 30, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    isWithinUpgradeWindow.mockReturnValue(true);
    canSendUpgradeNudge.mockResolvedValue(false);
    alreadySentDay30();

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(result.upgradeSent).toBe(0);
    expect(result.disengagedSent).toBe(0);
  });

  test('90-day plan users never enter the 30->90 upgrade path', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map([[String(user._id), { planDuration: 90, razorpayPaymentId: 'pay_1', createdAt: daysAgo(27) }]]));
    isWithinUpgradeWindow.mockReturnValue(false); // matches the real implementation's behavior for planDuration !== 30

    const result = await runRetentionEngineJob();

    expect(getUpgradeSegment).not.toHaveBeenCalled();
    expect(result.upgradeSent).toBe(0);
    expect(result.disengagedSent).toBe(0);
  });
});

describe('runRetentionEngineJob - comeback fallback', () => {
  test('a user with no active payment/day-30/upgrade signal still gets a comeback reminder when segmented', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map()); // no payment info at all (legacy user)
    getComebackSegment.mockReturnValue('few_days');

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(user.phone, 'COMEBACK_MSG');
    expect(result.comebackSent).toBe(1);
  });

  test('comeback cooldown prevents a repeat send even if segmented', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map());
    getComebackSegment.mockReturnValue('yesterday');
    canSendComebackReminder.mockResolvedValue(false);

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(result.comebackSent).toBe(0);
  });

  test('a user with no segment (active today) gets no message at all', async () => {
    const user = makeUser();
    User.find.mockResolvedValue([user]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map());
    getComebackSegment.mockReturnValue(null);

    const result = await runRetentionEngineJob();

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(result.comebackSent).toBe(0);
  });

  test('a per-user error is isolated and does not abort the whole run', async () => {
    const goodUser = makeUser({ _id: 'u1', phone: '919000000001' });
    const badUser = makeUser({ _id: 'u2', phone: '919000000002' });
    User.find.mockResolvedValue([badUser, goodUser]);
    getLatestPaymentInfoMap.mockResolvedValue(new Map());
    getComebackSegment.mockImplementation((u) => {
      if (u._id === 'u2') throw new Error('boom');
      return 'yesterday';
    });

    const result = await runRetentionEngineJob();

    expect(result.errors).toBe(1);
    expect(result.comebackSent).toBe(1);
  });
});
