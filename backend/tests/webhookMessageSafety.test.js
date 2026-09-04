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
