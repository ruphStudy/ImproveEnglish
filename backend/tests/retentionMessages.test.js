/**
 * Template-based beta retention (cron/retentionMessages.js) and the read-only
 * subscription-cycle lookup. Integration tests use a REAL throwaway local mongod
 * (skipped without `mongod`); Redis is an in-memory fake; WhatsApp is mocked.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../config/openai', () => ({}));
jest.mock('../services/whatsappService', () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.T' }] }),
  sendWhatsAppMessage: jest.fn().mockResolvedValue({})
}));

const mockRedis = { store: new Map(), fail: false };
jest.mock('../config/redisClient', () => ({
  set: jest.fn(async (key, value, ...args) => {
    if (mockRedis.fail) throw new Error('redis down');
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

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const mongoose = require('mongoose');

const { runRetentionMessages, waitingReminderNumber, localDaysBetween } = require('../cron/retentionMessages');
const { sendTemplateMessage } = require('../services/whatsappService');

jest.setTimeout(60000);

const DAY = 24 * 60 * 60 * 1000;
const at = (base, minutes) => new Date(new Date(base).getTime() + minutes * 60000);

describe('waiting reminder schedule', () => {
  test('reminder 1 on local day +1 (catch-up +2), reminder 2 on +3 (catch-up +4), never more', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(waitingReminderNumber)).toEqual([null, 1, 1, 2, 2, null, null]);
  });
  test('local day counting follows the learner calendar and DST', () => {
    // notified 07:00 Toronto on Sat 7 Mar (EST); Sun 8 Mar 17:00 is EDT - still +1 day
    expect(localDaysBetween(new Date('2026-03-07T12:00:00Z'), new Date('2026-03-08T21:00:00Z'), 'America/Toronto')).toBe(1);
    // 17:00 Vancouver on 5 Nov is 01:00 UTC on 6 Nov - still +1 day from 4 Nov
    expect(localDaysBetween(new Date('2026-11-04T15:00:00Z'), new Date('2026-11-06T01:00:00Z'), 'America/Vancouver')).toBe(1);
  });
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const Lesson = require('../models/Lesson');
const LearnerEvent = require('../models/LearnerEvent');
const PaymentHistory = require('../models/PaymentHistory');
const FreeActivation = require('../models/FreeActivation');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const { getSubscriptionCycleMap } = require('../services/subscriptionCycles');
const { runRetentionEngineJob } = require('../cron/retentionEngine');

// 17:00 IST = 11:30 UTC; 17:00 Toronto (EST) = 22:00 UTC
const IST_5PM = new Date('2026-11-10T11:30:00Z');
const TORONTO_5PM = new Date('2026-11-10T22:00:00Z');

let n = 0;
async function learner(overrides = {}) {
  n++;
  return User.create({
    name: `L${n}`,
    phone: `9198765${String(40000 + n)}`,
    isActive: true,
    state: 'READY',
    level: 'beginner',
    currentDay: 6,
    expiryDate: at(IST_5PM, 20 * 24 * 60),
    ...overrides
  });
}
const waitingSince = (daysBefore, base = IST_5PM) => at(base, -daysBefore * 24 * 60 - 10 * 60); // that day's 07:00
async function paid(user, createdAt, planDuration = 30, id = `pay_${user._id}_${createdAt.getTime()}`) {
  await PaymentHistory.collection.insertOne({ userId: user._id, paymentStatus: 'success', planDuration, razorpayPaymentId: id, createdAt });
}
async function free(user, activatedAt, planDuration = 30) {
  return FreeActivation.collection.insertOne({ userId: user._id, phone: user.phone, promoCode: 'BETA100', status: 'activated', planDuration, activatedAt, level: 'beginner', listPriceInr: 499 });
}
async function completed(user, when, count = 1) {
  for (let i = 0; i < count; i++) await Lesson.collection.insertOne({ userId: user._id, day: i + 1, level: 'beginner', status: 'completed', completedAt: when, lessonText: 'x' });
}
const sent = () => sendTemplateMessage.mock.calls.map(c => [c[0], c[1], c[2]]);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('template retention (real MongoDB)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/retention_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    await LearnerEvent.init();
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
    process.env.RETENTION_ENGINE_ENABLED = 'true';
    process.env.WHATSAPP_LESSON_WAITING_TEMPLATE = 'lesson_waiting_reminder';
    process.env.WHATSAPP_PROGRESS_UPDATE_TEMPLATE = 'subscription_progress_update';
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    mockRedis.store.clear();
    mockRedis.fail = false;
    sendTemplateMessage.mockReset().mockResolvedValue({ messages: [{ id: 'wamid.T' }] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all([User, Lesson, LearnerEvent, PaymentHistory, FreeActivation, SpeakingAttempt].map(m => m.deleteMany({})));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ['RETENTION_ENGINE_ENABLED', 'WHATSAPP_LESSON_WAITING_TEMPLATE', 'WHATSAPP_PROGRESS_UPDATE_TEMPLATE', 'INTERNATIONAL_SCHEDULING_ENABLED']) delete process.env[k];
  });

  test('subscription cycles: paid and FREE_PROMO, latest wins, failed payments ignored, nothing written', async () => {
    const p = await learner();
    const f = await learner();
    const renewed = await learner();
    await paid(p, at(IST_5PM, -10 * 24 * 60));
    await PaymentHistory.collection.insertOne({ userId: p._id, paymentStatus: 'failed', planDuration: 90, razorpayPaymentId: 'x', createdAt: IST_5PM });
    const fa = await free(f, at(IST_5PM, -24 * 24 * 60));
    await free(renewed, at(IST_5PM, -40 * 24 * 60));
    await paid(renewed, at(IST_5PM, -5 * 24 * 60), 90, 'pay_renew');
    const before = await PaymentHistory.countDocuments();

    const map = await getSubscriptionCycleMap([p._id, f._id, renewed._id]);
    expect(map.get(String(p._id))).toMatchObject({ source: 'PAID', planDuration: 30 });
    expect(map.get(String(f._id))).toMatchObject({ source: 'FREE_PROMO', planDuration: 30, cycleKey: `free:${fa.insertedId}` });
    expect(map.get(String(renewed._id))).toMatchObject({ source: 'PAID', planDuration: 90, cycleKey: 'paid:pay_renew' });
    expect(await PaymentHistory.countDocuments()).toBe(before);
  });

  test('flags: off = no retention messages at all; the old plain-text engine is retired in both modes', async () => {
    delete process.env.RETENTION_ENGINE_ENABLED;
    await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1) });
    expect(await runRetentionMessages({ now: IST_5PM })).toEqual({ skipped: true, reason: 'disabled' });
    process.env.RETENTION_ENGINE_ENABLED = 'true';
    expect(await runRetentionEngineJob()).toEqual({ skipped: true, reason: 'retired' });
    delete process.env.RETENTION_ENGINE_ENABLED;
    expect(await runRetentionEngineJob()).toEqual({ skipped: true, reason: 'retired' });
  });

  test('waiting reminders: day +1 and +3 about the same lesson, never a third, progress unchanged', async () => {
    const u = await learner({ state: 'WAITING_START', currentDay: 6, lastNotificationDate: waitingSince(1) });
    const notified = u.lastNotificationDate;
    for (let d = 0; d <= 5; d++) {
      mockRedis.store.clear();
      await runRetentionMessages({ now: at(IST_5PM, d * 24 * 60) });
    }
    expect(sent()).toEqual([
      [u.phone, 'lesson_waiting_reminder', [u.name, '6']],
      [u.phone, 'lesson_waiting_reminder', [u.name, '6']]
    ]);
    const days = (await LearnerEvent.find({ type: 'LESSON_WAITING_REMINDER' }).sort({ occurredAt: 1 }).lean())
      .map(e => Math.round((e.occurredAt - notified) / DAY));
    expect(days).toEqual([1, 3]);
    expect(await User.findById(u._id).lean()).toMatchObject({ currentDay: 6, state: 'WAITING_START' });
    expect(await Lesson.countDocuments()).toBe(0);
  });

  test('START before the reminder: nothing; no false "missed" message for active READY learners', async () => {
    await learner({ state: 'READY', currentDay: 7, lastNotificationDate: waitingSince(1), lastLessonCompletedDate: at(IST_5PM, -33 * 60) });
    await runRetentionMessages({ now: IST_5PM });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('restart and concurrent runs send once', async () => {
    await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1) });
    await Promise.all([runRetentionMessages({ now: IST_5PM }), runRetentionMessages({ now: IST_5PM })]);
    mockRedis.store.clear(); // restart: marker gone; LearnerEvent claim still blocks
    await runRetentionMessages({ now: at(IST_5PM, 10) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  test('progress update: day 25 of a 30-day plan, once per cycle, counts only this cycle, free and paid', async () => {
    const p = await learner({ expiryDate: at(IST_5PM, 6 * 24 * 60) });
    const f = await learner({ expiryDate: at(IST_5PM, 6 * 24 * 60) });
    const start = at(IST_5PM, -24 * 24 * 60); // today is subscription day 25
    await paid(p, start);
    await free(f, start);
    await completed(p, at(start, -60 * 24), 4); // previous cycle - not counted
    await completed(p, at(start, 60), 3);
    await SpeakingAttempt.collection.insertMany([{ userId: p._id, createdAt: at(start, 120) }, { userId: p._id, createdAt: at(start, -60) }]);

    await runRetentionMessages({ now: IST_5PM });
    mockRedis.store.clear();
    await runRetentionMessages({ now: at(IST_5PM, 24 * 60) }); // day 26: already sent this cycle
    const expiry = p.expiryDate.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
    expect(sent()).toEqual(expect.arrayContaining([
      [p.phone, 'subscription_progress_update', [p.name, '3', '1', expiry]],
      [f.phone, 'subscription_progress_update', [f.name, '0', '0', expiry]]
    ]));
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(await LearnerEvent.findOne({ userId: f._id, type: 'PROGRESS_UPDATE' }).lean()).toMatchObject({ dedupeKey: expect.stringMatching(/^free:/), metadata: { status: 'accepted', source: 'FREE_PROMO' } });
  });

  test('renewal starts a new cycle: a new progress update is allowed for it', async () => {
    const u = await learner({ expiryDate: at(IST_5PM, 6 * 24 * 60) });
    await paid(u, at(IST_5PM, -24 * 24 * 60), 30, 'pay_1');
    await runRetentionMessages({ now: IST_5PM });
    await paid(u, at(IST_5PM, 6 * 24 * 60), 30, 'pay_2'); // renewed at old expiry
    await User.updateOne({ _id: u._id }, { expiryDate: at(IST_5PM, 36 * 24 * 60) });
    mockRedis.store.clear();
    await runRetentionMessages({ now: at(IST_5PM, 30 * 24 * 60) }); // day 25 of the new cycle
    expect(sent().filter(s => s[1] === 'subscription_progress_update').length).toBe(2);
  });

  test('no messages after expiry, for inactive or opted-out learners, or non-30-day plans', async () => {
    const expired = await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1), expiryDate: at(IST_5PM, -1) });
    await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1), isActive: false });
    await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1), retentionOptOut: true });
    const long = await learner();
    await paid(expired, at(IST_5PM, -24 * 24 * 60));
    await paid(long, at(IST_5PM, -24 * 24 * 60), 90);
    await runRetentionMessages({ now: IST_5PM });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('at most one account message per local date, counting expiry reminders', async () => {
    const u = await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1), expiryDate: at(IST_5PM, 6 * 24 * 60) });
    await paid(u, at(IST_5PM, -24 * 24 * 60)); // also due a progress update today
    await LearnerEvent.create({ userId: u._id, type: 'EXPIRY_REMINDER_SENT', dedupeKey: '7day-x', occurredAt: at(IST_5PM, -8 * 60), metadata: { status: 'accepted' } });
    await runRetentionMessages({ now: IST_5PM });
    expect(sendTemplateMessage).not.toHaveBeenCalled(); // expiry reminder already went out today

    mockRedis.store.clear();
    await runRetentionMessages({ now: at(IST_5PM, 24 * 60) }); // next day: one message only (waiting has priority)
    expect(sent().map(s => s[1])).toEqual(['lesson_waiting_reminder']);
  });

  test('unconfigured template: nothing claimed or sent; it goes out once configured', async () => {
    delete process.env.WHATSAPP_LESSON_WAITING_TEMPLATE;
    const u = await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1) });
    expect(await runRetentionMessages({ now: IST_5PM })).toMatchObject({ skippedUnconfigured: 1, accepted: 0 });
    expect(await LearnerEvent.countDocuments()).toBe(0);
    process.env.WHATSAPP_LESSON_WAITING_TEMPLATE = 'lesson_waiting_reminder';
    mockRedis.store.clear();
    await runRetentionMessages({ now: at(IST_5PM, 24 * 60) }); // +2: reminder 1 catch-up
    expect(sent()).toEqual([[u.phone, 'lesson_waiting_reminder', [u.name, '6']]]);
  });

  test('failed WhatsApp send is recorded as failed and not retried', async () => {
    await learner({ state: 'WAITING_START', lastNotificationDate: waitingSince(1) });
    sendTemplateMessage.mockRejectedValueOnce(new Error('template not approved'));
    expect(await runRetentionMessages({ now: IST_5PM })).toMatchObject({ failed: 1 });
    expect((await LearnerEvent.findOne({ type: 'LESSON_WAITING_REMINDER' }).lean()).metadata).toMatchObject({ status: 'failed', error: 'template not approved' });
    mockRedis.store.clear();
    await runRetentionMessages({ now: at(IST_5PM, 10) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  test('timing: 17:00 IST with international scheduling off; local 17:00 per zone when on; Redis down = nothing', async () => {
    const t = await learner({ timezone: 'America/Toronto', phone: '14165557001', state: 'WAITING_START', lastNotificationDate: waitingSince(1, TORONTO_5PM) });
    await runRetentionMessages({ now: at(IST_5PM, -1) }); // 16:59 IST
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    process.env.INTERNATIONAL_SCHEDULING_ENABLED = 'true';
    await runRetentionMessages({ now: IST_5PM }); // 17:00 IST - Toronto learner not in the IST group now
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runRetentionMessages({ now: TORONTO_5PM });
    expect(sent()).toEqual([[t.phone, 'lesson_waiting_reminder', [t.name, '6']]]);

    mockRedis.store.clear();
    mockRedis.fail = true;
    await User.create({ name: 'X', phone: '14165557002', isActive: true, state: 'WAITING_START', currentDay: 2, timezone: 'America/Toronto', lastNotificationDate: waitingSince(1, TORONTO_5PM), expiryDate: at(TORONTO_5PM, 20 * DAY / 60000) });
    expect(await runRetentionMessages({ now: at(TORONTO_5PM, 5) })).toMatchObject({ skipped: true });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
