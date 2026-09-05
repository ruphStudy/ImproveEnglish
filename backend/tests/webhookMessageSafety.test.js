jest.mock('../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Lesson', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/CurriculumTopic', () => ({ findOne: jest.fn() }));
jest.mock('../models/TutorMemory', () => ({ findOne: jest.fn() }));
jest.mock('../models/PendingOrder', () => ({ create: jest.fn() }));
jest.mock('../models/PlanMaster', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
  sendWhatsAppMessage: jest.fn().mockResolvedValue({}),
  sendTemplateMessage: jest.fn().mockResolvedValue({})
}));
jest.mock('../services/voiceEvaluationService', () => ({
  processVoiceEvaluation: jest.fn()
}));
jest.mock('../services/promoService', () => ({
  validatePromoCode: jest.fn()
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../utils/whatsappDedupe', () => ({
  isDuplicateMessage: jest.fn().mockResolvedValue(false)
}));
jest.mock('../services/onboardingService', () => ({
  needsOnboarding: jest.fn().mockReturnValue(false),
  handleOnboardingMessage: jest.fn()
}));

const User = require('../models/User');
const Log = require('../models/Log');
const webhookController = require('../controllers/webhookController');

function mockRes() {
  const res = {};
  res.sendStatus = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function webhookReqWithMessage(message) {
  return {
    body: {
      entry: [{ changes: [{ value: { messages: [message] } }] }]
    }
  };
}

const existingUser = { _id: 'u1', name: 'Rajesh', phone: '919000000001', state: 'READY', currentDay: 5, streak: 2 };

describe('handleWebhook - unsupported/non-text message types do not crash', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findOne.mockResolvedValue(existingUser);
    Log.create.mockResolvedValue({});
  });

  test('a sticker message is ignored gracefully, request still acknowledged', async () => {
    const req = webhookReqWithMessage({ id: 'wamid.sticker1', from: existingUser.phone, type: 'sticker', sticker: { id: 'sticker123' } });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('an interactive button-reply message is ignored gracefully', async () => {
    const req = webhookReqWithMessage({
      id: 'wamid.interactive1',
      from: existingUser.phone,
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Yes' } }
    });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('a location message is ignored gracefully', async () => {
    const req = webhookReqWithMessage({
      id: 'wamid.location1',
      from: existingUser.phone,
      type: 'location',
      location: { latitude: 12.9, longitude: 77.6 }
    });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('a genuinely unknown/unsupported type does not crash, and a per-message error is isolated and logged rather than aborting the batch', async () => {
    // Force an internal failure while processing this specific message (simulates
    // a transient DB error) to prove one bad message can't 500 the whole webhook.
    User.findOne.mockRejectedValueOnce(new Error('Mongo blip'));

    const req = webhookReqWithMessage({ id: 'wamid.unsupported1', from: existingUser.phone, type: 'unsupported' });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'WEBHOOK_MESSAGE_ERROR' }));
  });
});

describe('handleWebhook - audio message sets lastFluencyScore from the truthful overall score', () => {
  const { processVoiceEvaluation } = require('../services/voiceEvaluationService');
  const { sendWhatsAppMessage, sendTemplateMessage } = require('../services/whatsappService');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('lastFluencyScore is set from result.overallScore, and the old pronunciation template is never used', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const audioUser = { ...existingUser, save };
    User.findOne.mockResolvedValue(audioUser);
    processVoiceEvaluation.mockResolvedValue({
      success: true,
      overallScore: 8,
      messageText: '🎤 Speaking Feedback\n\nOverall: 8/10'
    });

    const req = webhookReqWithMessage({ id: 'wamid.audio1', from: existingUser.phone, type: 'audio', audio: { id: 'media1' } });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(audioUser.lastFluencyScore).toBe(8);
    expect(save).toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(existingUser.phone, expect.stringContaining('8/10'));
    expect(sendTemplateMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      'voice_evaluation_result_new',
      expect.anything(),
      expect.anything()
    );
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});

describe('handleWebhook - onboarding gating (state NEW)', () => {
  const { needsOnboarding, handleOnboardingMessage } = require('../services/onboardingService');
  const { sendWhatsAppMessage } = require('../services/whatsappService');
  const CurriculumTopic = require('../models/CurriculumTopic');
  const PlanMaster = require('../models/PlanMaster');

  const onboardingUser = { _id: 'u2', name: 'Priya', phone: '919000000002', state: 'NEW', onboardingStatus: 'PENDING_GOAL', currentDay: 1, streak: 0 };

  beforeEach(() => {
    jest.clearAllMocks();
    needsOnboarding.mockReturnValue(false);
  });

  test('START sent too early (mid-onboarding) is routed to onboarding, not the normal on-demand lesson flow', async () => {
    User.findOne.mockResolvedValue({ ...onboardingUser });
    needsOnboarding.mockReturnValue(true);
    handleOnboardingMessage.mockResolvedValue({ messageText: 'Please finish setup first: reply with 1-7.' });

    const req = webhookReqWithMessage({ id: 'wamid.start1', from: onboardingUser.phone, text: { body: 'START' } });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(handleOnboardingMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(onboardingUser.phone, 'Please finish setup first: reply with 1-7.');
    expect(CurriculumTopic.findOne).not.toHaveBeenCalled(); // normal START-in-READY lesson generation never ran
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('UPGRADE still works even while onboarding is pending', async () => {
    User.findOne.mockResolvedValue({ ...onboardingUser, isActive: true, level: 'beginner' });
    needsOnboarding.mockReturnValue(true);
    PlanMaster.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([{ level: 'bigenner', days: 30, price: 499 }]) });

    const req = webhookReqWithMessage({ id: 'wamid.upgrade1', from: onboardingUser.phone, text: { body: 'UPGRADE' } });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(handleOnboardingMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(onboardingUser.phone, expect.stringContaining('Choose your upgrade plan'));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('an onboarding-completed user is dispatched normally, unaffected by the onboarding gate', async () => {
    User.findOne.mockResolvedValue({ ...existingUser }); // state READY, onboardingStatus undefined

    const req = webhookReqWithMessage({ id: 'wamid.sticker2', from: existingUser.phone, type: 'sticker', sticker: { id: 's1' } });
    const res = mockRes();
    const next = jest.fn();

    await webhookController.handleWebhook(req, res, next);

    expect(handleOnboardingMessage).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});
