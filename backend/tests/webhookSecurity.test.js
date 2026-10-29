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

const crypto = require('crypto');
const express = require('express');
const applyBodyParsers = require('../middleware/bodyParsers');
const webhookRoutes = require('../routes/webhookRoutes');
const User = require('../models/User');

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

const messageEvent = JSON.stringify({
  entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '919999999999', type: 'text', text: { body: 'START' } }] } }] }]
});
const statusEvent = JSON.stringify({
  entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }]
});

function sign(body, secret = APP_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

let server;
let baseUrl;
let razorpayBody;
let jsonBody;

beforeAll((done) => {
  const app = express();
  applyBodyParsers(app);
  app.post('/api/payments/razorpay-webhook', (req, res) => { razorpayBody = req.body; res.sendStatus(200); });
  app.post('/api/register', (req, res) => { jsonBody = req.body; res.sendStatus(200); });
  app.use('/api', webhookRoutes);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

const originalEnv = { ...process.env };
let logSpy;
let warnSpy;
let errorSpy;

beforeEach(() => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  User.findOne.mockReset().mockResolvedValue(null);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

function allLogs() {
  return [logSpy, warnSpy, errorSpy].flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
}

function postWebhook(body, headers = {}) {
  return fetch(`${baseUrl}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
}

describe('GET /api/webhook verification', () => {
  const verifyUrl = (token, mode = 'subscribe') =>
    `${baseUrl}/api/webhook?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=12345`;

  test('returns the exact challenge for a valid token', async () => {
    const res = await fetch(verifyUrl(VERIFY_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
    expect(allLogs()).not.toContain(VERIFY_TOKEN);
    expect(allLogs()).not.toContain('12345');
  });

  test('rejects an invalid token with 403', async () => {
    const res = await fetch(verifyUrl('wrong-token'));
    expect(res.status).toBe(403);
    expect(allLogs()).not.toContain('wrong-token');
  });

  test('rejects a wrong mode with 403', async () => {
    const res = await fetch(verifyUrl(VERIFY_TOKEN, 'unsubscribe'));
    expect(res.status).toBe(403);
  });

  test('rejects when WHATSAPP_VERIFY_TOKEN is unset', async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const res = await fetch(`${baseUrl}/api/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/webhook signature', () => {
  test('a correctly signed message reaches the controller', async () => {
    const res = await postWebhook(messageEvent, { 'X-Hub-Signature-256': sign(messageEvent) });
    expect(res.status).toBe(200);
    expect(User.findOne).toHaveBeenCalledWith({ phone: '919999999999' });
    expect(allLogs()).not.toContain('START');
    expect(allLogs()).not.toContain(sign(messageEvent));
  });

  test('a correctly signed status-only event returns 200 without processing', async () => {
    const res = await postWebhook(statusEvent, { 'X-Hub-Signature-256': sign(statusEvent) });
    expect(res.status).toBe(200);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects a missing signature with 403', async () => {
    const res = await postWebhook(messageEvent);
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects an invalid signature with 403', async () => {
    const res = await postWebhook(messageEvent, { 'X-Hub-Signature-256': sign(messageEvent, 'other-secret') });
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects a signature over a tampered body with 403', async () => {
    const tampered = messageEvent.replace('START', 'UPGRADE');
    const res = await postWebhook(tampered, { 'X-Hub-Signature-256': sign(messageEvent) });
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test.each([
    ['no prefix', () => sign(messageEvent).slice('sha256='.length)],
    ['wrong algorithm', () => sign(messageEvent).replace('sha256=', 'sha1=')],
    ['short digest', () => 'sha256=abcd'],
    ['non-hex digest', () => 'sha256=' + 'z'.repeat(64)]
  ])('rejects a malformed signature (%s) with 403', async (_label, header) => {
    const res = await postWebhook(messageEvent, { 'X-Hub-Signature-256': header() });
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('fails closed with 403 when META_APP_SECRET is unset', async () => {
    delete process.env.META_APP_SECRET;
    const res = await postWebhook(messageEvent, { 'X-Hub-Signature-256': sign(messageEvent) });
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('rejects unsigned malformed JSON with 403', async () => {
    const res = await postWebhook('{not json');
    expect(res.status).toBe(403);
  });

  test('rejects signed malformed JSON with 400 without processing', async () => {
    const body = '{not json';
    const res = await postWebhook(body, { 'X-Hub-Signature-256': sign(body) });
    expect(res.status).toBe(400);
    expect(User.findOne).not.toHaveBeenCalled();
  });
});

describe('body parser regression', () => {
  test('Razorpay webhook still receives the raw body Buffer', async () => {
    const body = '{"event":"payment.captured"}';
    const res = await fetch(`${baseUrl}/api/payments/razorpay-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(razorpayBody)).toBe(true);
    expect(razorpayBody.toString('utf8')).toBe(body);
  });

  test('other routes still get parsed JSON', async () => {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"a"}'
    });
    expect(res.status).toBe(200);
    expect(jsonBody).toEqual({ name: 'a' });
  });
});
