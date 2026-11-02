/**
 * Local-time noon / evening reminders for international learners.
 * Unit tests for the windows and local-date bounds, and integration tests against
 * a REAL throwaway local mongod (skipped without a `mongod` binary). Redis is an
 * in-memory fake with SET NX semantics; WhatsApp is mocked (no live sends).
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({}),
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

const { runInternationalLessonReminders, dueReminder, localDayBounds } = require('../cron/internationalLessonReminders');
const { indiaScheduleFilter } = require('../services/lessonScheduling');
const { sendTemplateMessage } = require('../services/whatsappService');

jest.setTimeout(60000);

describe('local reminder windows', () => {
  test.each([
    ['America/Toronto', '2026-11-04T17:00:00Z', '2026-11-04T23:00:00Z'], // EST
    ['America/Toronto', '2026-03-08T16:00:00Z', '2026-03-08T22:00:00Z'], // DST start day (EDT)
    ['America/Toronto', '2026-11-01T17:00:00Z', '2026-11-01T23:00:00Z'], // DST end day (EST)
    ['America/Vancouver', '2026-11-04T20:00:00Z', '2026-11-05T02:00:00Z'], // evening is the next UTC date
    ['Europe/London', '2026-11-04T12:00:00Z', '2026-11-04T18:00:00Z'],
    ['Europe/London', '2026-03-29T11:00:00Z', '2026-03-29T17:00:00Z'], // BST start day
    ['America/St_Johns', '2026-11-04T15:30:00Z', '2026-11-04T21:30:00Z'], // -03:30
    ['Asia/Kathmandu', '2026-11-04T06:15:00Z', '2026-11-04T12:15:00Z'] // +05:45
  ])('%s: noon at %s, evening at %s (local 12:00 / 18:00)', (zone, noon, evening) => {
    const min = (d, m) => new Date(new Date(d).getTime() + m * 60000);
    expect(dueReminder(min(noon, -1), zone)).toBeNull(); // 11:59
    expect(dueReminder(new Date(noon), zone).key).toBe('noon');
    expect(dueReminder(min(noon, 179), zone).key).toBe('noon'); // 14:59 catch-up
    expect(dueReminder(min(noon, 180), zone)).toBeNull(); // 15:00 cut-off
    expect(dueReminder(min(evening, -1), zone)).toBeNull();
    expect(dueReminder(new Date(evening), zone).key).toBe('evening');
    expect(dueReminder(min(evening, 179), zone).key).toBe('evening'); // 20:59
    expect(dueReminder(min(evening, 180), zone)).toBeNull(); // 21:00 - no bedtime reminders
  });

  test('local day bounds follow the learner calendar across UTC date boundaries', () => {
    // 18:00 Vancouver on 4 Nov is 02:00 UTC on 5 Nov - still the learner's 4 Nov
    const b = localDayBounds(new Date('2026-11-05T02:00:00Z'), 'America/Vancouver');
    expect(b.start.toISOString()).toBe('2026-11-04T08:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-11-05T08:00:00.000Z');
    // DST end day in Toronto is 25 hours long
    const d = localDayBounds(new Date('2026-11-01T17:00:00Z'), 'America/Toronto');
    expect((d.end - d.start) / 3600000).toBe(25);
  });
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');

const TORONTO_7AM = new Date('2026-11-04T12:00:00Z');
const TORONTO_NOON = new Date('2026-11-04T17:00:00Z');
const TORONTO_6PM = new Date('2026-11-04T23:00:00Z');
const at = (base, minutes) => new Date(base.getTime() + minutes * 60000);

let n = 0;
async function waiting(overrides = {}) {
  n++;
  return User.create({
    name: `Learner${n}`,
    phone: `1416555${String(2000 + n)}`,
    isActive: true,
    state: 'WAITING_START',
    currentDay: 5,
    timezone: 'America/Toronto',
    lastNotificationDate: at(TORONTO_7AM, 1),
    noonReminderSent: false,
    eveningReminderSent: false,
    expiryDate: at(TORONTO_7AM, 20 * 24 * 60),
    ...overrides
  });
}
const sentTo = () => sendTemplateMessage.mock.calls.map(c => [c[0], c[1]]);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('international reminders (real MongoDB)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/intl_reminder_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
  });

  afterAll(async () => {
    await mongoose.disconnect().catch(() => {});
    if (mongod) {
      // wait for mongod to exit (it keeps writing while shutting down), then clean up
      const exited = new Promise(r => mongod.once('exit', r));
      mongod.kill('SIGTERM');
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    }
    fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  beforeEach(async () => {
    process.env.INTERNATIONAL_SCHEDULING_ENABLED = 'true';
    mockRedis.store.clear();
    mockRedis.fail = false;
    sendTemplateMessage.mockReset().mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await User.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
  });

  test('flag off: nothing is sent locally; the IST reminders keep every learner', async () => {
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    await waiting();
    expect(await runInternationalLessonReminders({ now: TORONTO_NOON })).toEqual({ skipped: true, reason: 'disabled' });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(await indiaScheduleFilter()).toEqual({});
  });

  test('flag on: Pune / no-timezone learners stay on the IST reminders only; Toronto only on local ones', async () => {
    const legacy = await waiting({ timezone: undefined, phone: '919876500001' });
    const pune = await waiting({ timezone: 'Asia/Kolkata', phone: '919876500002' });
    const toronto = await waiting();
    const ist = await User.find({ ...(await indiaScheduleFilter()), state: 'WAITING_START' }).select('_id').lean();
    expect(ist.map(u => String(u._id)).sort()).toEqual([legacy, pune].map(u => String(u._id)).sort());

    await runInternationalLessonReminders({ now: TORONTO_NOON });
    expect(sentTo()).toEqual([[toronto.phone, 'lesson_reminder_noon']]);
  });

  test('Toronto: one noon and one evening reminder with the same template parameters; restarts and repeat ticks send nothing more', async () => {
    const t = await waiting();
    await runInternationalLessonReminders({ now: TORONTO_NOON });
    await runInternationalLessonReminders({ now: at(TORONTO_NOON, 5) });
    mockRedis.store.clear(); // restart
    await runInternationalLessonReminders({ now: at(TORONTO_NOON, 10) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage).toHaveBeenCalledWith(t.phone, 'lesson_reminder_noon', [t.name, '5'], 'en_US');

    await runInternationalLessonReminders({ now: TORONTO_6PM });
    await runInternationalLessonReminders({ now: at(TORONTO_6PM, 5) });
    expect(sentTo()).toEqual([[t.phone, 'lesson_reminder_noon'], [t.phone, 'lesson_reminder_evening']]);
    const after = await User.findById(t._id).lean();
    expect(after).toMatchObject({ noonReminderSent: true, eveningReminderSent: true, currentDay: 5, state: 'WAITING_START' });
  });

  test('START before the reminder: no reminder', async () => {
    await waiting({ state: 'READY', currentDay: 6, lastSeenAt: at(TORONTO_7AM, 30) });
    await runInternationalLessonReminders({ now: TORONTO_NOON });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('notification from a previous local date: no reminder', async () => {
    await waiting({ lastNotificationDate: at(TORONTO_7AM, -24 * 60) });
    await runInternationalLessonReminders({ now: TORONTO_NOON });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('Vancouver evening crosses the UTC date but is the same local date', async () => {
    const v = await waiting({ timezone: 'America/Vancouver', lastNotificationDate: new Date('2026-11-04T15:00:30Z') });
    await runInternationalLessonReminders({ now: new Date('2026-11-05T02:00:00Z') });
    expect(sentTo()).toEqual([[v.phone, 'lesson_reminder_evening']]);
  });

  test('delayed ticks catch up inside the window only', async () => {
    const a = await waiting();
    await runInternationalLessonReminders({ now: at(TORONTO_NOON, 3 * 60) }); // 15:00 - noon window closed
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalLessonReminders({ now: at(TORONTO_6PM, 150) }); // 20:30 - evening catch-up
    expect(sentTo()).toEqual([[a.phone, 'lesson_reminder_evening']]);
    sendTemplateMessage.mockClear();
    await User.updateOne({ _id: a._id }, { eveningReminderSent: false });
    await runInternationalLessonReminders({ now: at(TORONTO_6PM, 180) }); // 21:00 - too late
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('concurrent runs send once; Redis outage sends nothing', async () => {
    await waiting();
    await Promise.all([
      runInternationalLessonReminders({ now: TORONTO_NOON }),
      runInternationalLessonReminders({ now: TORONTO_NOON })
    ]);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);

    await User.updateMany({}, { noonReminderSent: false });
    sendTemplateMessage.mockClear();
    mockRedis.store.clear();
    mockRedis.fail = true;
    expect(await runInternationalLessonReminders({ now: at(TORONTO_NOON, 5) })).toMatchObject({ skipped: true });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('a failed send is not retried every 5 minutes (at most one reminder)', async () => {
    await waiting();
    sendTemplateMessage.mockRejectedValueOnce(new Error('template rejected'));
    expect(await runInternationalLessonReminders({ now: TORONTO_NOON })).toMatchObject({ sent: 0, failed: 1 });
    await runInternationalLessonReminders({ now: at(TORONTO_NOON, 5) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  test('expired, inactive and paused learners get nothing', async () => {
    await waiting({ expiryDate: at(TORONTO_7AM, -1) });
    await waiting({ isActive: false });
    await waiting({ state: 'PAUSED' });
    await runInternationalLessonReminders({ now: TORONTO_NOON });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  test('paid and free-beta learners are treated the same', async () => {
    const paid = await waiting({ lastAppliedPaymentId: 'pay_1' });
    const free = await waiting({ freeActivationId: new mongoose.Types.ObjectId() });
    await runInternationalLessonReminders({ now: TORONTO_NOON });
    expect(sentTo().map(s => s[0]).sort()).toEqual([paid.phone, free.phone].sort());
  });

  test('London, St John\'s and Kathmandu at their own local noon', async () => {
    const london = await waiting({ timezone: 'Europe/London', lastNotificationDate: new Date('2026-11-04T07:00:30Z') });
    const stJohns = await waiting({ timezone: 'America/St_Johns', lastNotificationDate: new Date('2026-11-04T10:30:30Z') });
    const ktm = await waiting({ timezone: 'Asia/Kathmandu', lastNotificationDate: new Date('2026-11-04T01:15:30Z') });
    await runInternationalLessonReminders({ now: new Date('2026-11-04T06:15:00Z') }); // Kathmandu 12:00
    await runInternationalLessonReminders({ now: new Date('2026-11-04T12:00:00Z') }); // London 12:00
    await runInternationalLessonReminders({ now: new Date('2026-11-04T15:30:00Z') }); // St John's 12:00
    expect(sentTo()).toEqual([[ktm.phone, 'lesson_reminder_noon'], [london.phone, 'lesson_reminder_noon'], [stJohns.phone, 'lesson_reminder_noon']]);
  });

  test('Toronto DST start day: noon at 12:00 EDT (16:00 UTC)', async () => {
    const t = await waiting({ lastNotificationDate: new Date('2026-03-08T11:00:30Z'), expiryDate: new Date('2026-04-01T00:00:00Z') });
    await runInternationalLessonReminders({ now: new Date('2026-03-08T15:59:00Z') });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalLessonReminders({ now: new Date('2026-03-08T16:00:00Z') });
    expect(sentTo()).toEqual([[t.phone, 'lesson_reminder_noon']]);
  });
});
