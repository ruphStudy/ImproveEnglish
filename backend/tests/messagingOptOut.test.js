/**
 * Full WhatsApp opt-out (User.whatsappOptOut, set by STOP / STOP ALL / UNSUBSCRIBE):
 * the central template guard, and every scheduled sender against a REAL
 * throwaway local mongod (skipped without `mongod`). Redis and the Bull queue are
 * in-memory fakes; WhatsApp and OpenAI are mocked - nothing is sent.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../config/openai', () => ({}));
jest.mock('../services/lessonGeneratorV2', () => ({
  generateLesson: jest.fn(async () => ({ lessonJson: {}, lessonText: 'L', scenarioType: 's', generationVersion: 'v3', validationStatus: 'valid', vocabList: [] }))
}));
jest.mock('../services/whatsappService', () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({}),
  sendWhatsAppMessage: jest.fn().mockResolvedValue({})
}));

const mockRedis = { store: new Map() };
jest.mock('../config/redisClient', () => ({
  set: jest.fn(async (key, value, ...args) => {
    if (args.includes('NX') && mockRedis.store.has(key)) return null;
    mockRedis.store.set(key, value);
    return 'OK';
  }),
  get: jest.fn(async (key) => (mockRedis.store.has(key) ? mockRedis.store.get(key) : null)),
  eval: jest.fn(async (script, n, key, token) => {
    if (mockRedis.store.get(key) === token) mockRedis.store.delete(key);
    return 1;
  })
}));

const mockQueue = { jobs: new Map() };
jest.mock('../config/queueConfig', () => ({
  lessonQueue: {
    add: jest.fn(async (data, opts) => {
      if (!mockQueue.jobs.has(opts.jobId)) mockQueue.jobs.set(opts.jobId, data);
      return { id: opts.jobId };
    })
  }
}));

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const mongoose = require('mongoose');

jest.setTimeout(60000);

describe('central template guard (whatsappService)', () => {
  let service;
  let post;
  let exists;

  beforeAll(() => {
    // The real service (this file mocks it for the scheduler tests below), with
    // the WhatsApp HTTP client, User and Log spied so nothing leaves the process.
    service = jest.requireActual('../services/whatsappService');
    post = jest.spyOn(require('../config/whatsapp'), 'post').mockResolvedValue({ data: { messages: [{ id: 'wamid.X' }] } });
    exists = jest.spyOn(require('../models/User'), 'exists');
    jest.spyOn(require('../models/Log'), 'create').mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => jest.restoreAllMocks());
  beforeEach(() => { post.mockClear(); exists.mockReset(); });

  test('blocks template sends to opted-out learners without calling WhatsApp', async () => {
    exists.mockResolvedValue({ _id: 'u1' });
    await expect(service.sendTemplateMessage('919000000001', 'daily_lesson_notification', ['A', '2', 'x'], 'en_US'))
      .rejects.toMatchObject({ code: 'WHATSAPP_OPTED_OUT' });
    expect(exists).toHaveBeenCalledWith({ phone: '919000000001', whatsappOptOut: true });
    expect(post).not.toHaveBeenCalled();
  });

  test('sends normally for learners who never opted out (including existing users without the field)', async () => {
    exists.mockResolvedValue(null);
    await service.sendTemplateMessage('919000000002', 'weekly_summary_new', ['A', '1', '2'], 'en_US');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].template).toMatchObject({ name: 'weekly_summary_new', language: { code: 'en_US' } });
  });

  test('allowOptedOut (direct reply to the learner\'s own action) skips the check', async () => {
    exists.mockResolvedValue({ _id: 'u1' });
    await service.sendTemplateMessage('919000000001', 'payment_welcome_new', ['A', '30', 'beginner', '2026-12-01'], 'en_US', { allowOptedOut: true });
    expect(exists).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('plain conversational replies are not affected by the guard', async () => {
    exists.mockResolvedValue({ _id: 'u1' });
    await service.sendWhatsAppMessage('919000000001', 'Here is your lesson');
    expect(exists).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const LearnerEvent = require('../models/LearnerEvent');
const { sendTemplateMessage } = require('../services/whatsappService');
const { generateLesson } = require('../services/lessonGeneratorV2');
const { processLessonJob } = require('../workers/lessonWorker');
const { runDailyLessonJob } = require('../cron/dailyLesson');
const { runInternationalLessonScheduler } = require('../cron/internationalLessonScheduler');
const { runInternationalLessonReminders } = require('../cron/internationalLessonReminders');
const { runInternationalNotifications } = require('../cron/internationalNotifications');
const { runNoonReminderJob } = require('../cron/lessonReminder');
const { runExpiryReminderJob } = require('../cron/expiryReminder');
const { runRetentionMessages } = require('../cron/retentionMessages');

const DAY = 24 * 60 * 60 * 1000;

let n = 0;
function learner(overrides = {}) {
  n++;
  return User.create({
    name: `L${n}`, phone: `9198765${String(50000 + n)}`, isActive: true, state: 'READY', level: 'beginner',
    currentDay: 3, expiryDate: new Date(Date.now() + 20 * DAY), createdAt: new Date(Date.now() - 5 * DAY), ...overrides
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('opted-out learners get no scheduled messages (real MongoDB)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/optout_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
  });

  afterAll(async () => {
    await mongoose.disconnect().catch(() => {});
    if (mongod) {
      const exited = new Promise(r => mongod.once('exit', r));
      mongod.kill('SIGTERM');
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    }
    fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  beforeEach(async () => {
    process.env.INTERNATIONAL_SCHEDULING_ENABLED = 'true';
    process.env.RETENTION_ENGINE_ENABLED = 'true';
    process.env.WHATSAPP_LESSON_WAITING_TEMPLATE = 'lesson_waiting_reminder';
    mockRedis.store.clear();
    mockQueue.jobs.clear();
    sendTemplateMessage.mockReset().mockResolvedValue({});
    generateLesson.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all([User.deleteMany({}), LearnerEvent.deleteMany({})]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ['INTERNATIONAL_SCHEDULING_ENABLED', 'RETENTION_ENGINE_ENABLED', 'WHATSAPP_LESSON_WAITING_TEMPLATE']) delete process.env[k];
  });

  test('daily lessons: IST and international schedulers skip opted-out learners; others still queued', async () => {
    const indiaOut = await learner({ whatsappOptOut: true });
    const indiaIn = await learner(); // existing-style user without opt-out fields set explicitly
    const torontoOut = await learner({ timezone: 'America/Toronto', phone: '14165558001', whatsappOptOut: true });
    await runDailyLessonJob();
    await runInternationalLessonScheduler({ now: new Date('2026-11-04T12:00:00Z') });
    const queued = [...mockQueue.jobs.values()].map(j => j.userId);
    expect(queued).toEqual([String(indiaIn._id)]);
    expect(queued).not.toContain(String(indiaOut._id));
    expect(queued).not.toContain(String(torontoOut._id));
  });

  test('STOP after queuing: the worker skips - no lesson generated, nothing sent, day and state kept', async () => {
    const u = await learner();
    await runDailyLessonJob();
    await User.updateOne({ _id: u._id }, { whatsappOptOut: true }); // STOP arrives before the job runs
    const result = await processLessonJob(String(u._id));
    expect(result).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect(generateLesson).not.toHaveBeenCalled();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(await User.findById(u._id).lean()).toMatchObject({ state: 'READY', currentDay: 3 });
  });

  test('noon/evening, expiry, weekly and retention senders skip opted-out learners (IST and local)', async () => {
    const notifiedToday = new Date();
    const out = { whatsappOptOut: true };
    await learner({ ...out, state: 'WAITING_START', lastNotificationDate: notifiedToday, noonReminderSent: false });
    await learner({ ...out, expiryDate: new Date(Date.now() + 5 * DAY) });
    await learner({ ...out, timezone: 'America/Toronto', phone: '14165558002', state: 'WAITING_START', lastNotificationDate: new Date('2026-11-04T12:00:30Z') });
    await learner({ ...out, timezone: 'America/Toronto', phone: '14165558003', expiryDate: new Date('2026-11-09T20:00:00Z') });
    await learner({ ...out, state: 'WAITING_START', lastNotificationDate: new Date(Date.now() - 1 * DAY - 60 * 1000) });

    await runNoonReminderJob();
    await runExpiryReminderJob();
    await runInternationalLessonReminders({ now: new Date('2026-11-04T17:00:00Z') }); // Toronto noon
    await runInternationalNotifications({ now: new Date('2026-11-04T14:00:00Z') }); // Toronto 09:00
    await runInternationalNotifications({ now: new Date('2026-11-08T23:00:00Z') }); // Toronto Sunday 18:00
    for (const hour of [11, 12, 13]) { // retention at 17:00 IST, whatever the current date
      const now = new Date(); now.setUTCHours(hour, 30, 0, 0);
      mockRedis.store.clear();
      await runRetentionMessages({ now });
    }
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('RESUME: the same learners are scheduled again', async () => {
    const u = await learner({ whatsappOptOut: true });
    await runDailyLessonJob();
    expect(mockQueue.jobs.size).toBe(0);
    await User.updateOne({ _id: u._id }, { whatsappOptOut: false, whatsappOptOutAt: null });
    await runDailyLessonJob();
    expect([...mockQueue.jobs.values()].map(j => j.userId)).toEqual([String(u._id)]);
  });
});
