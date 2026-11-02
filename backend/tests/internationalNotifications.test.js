/**
 * Weekly summaries (Sunday 18:00 local) and expiry reminders (09:00 local) for
 * international learners, plus the IST jobs' split and expired-plan guard.
 * Integration tests use a REAL throwaway local mongod (skipped without `mongod`);
 * Redis is an in-memory fake with SET NX semantics; WhatsApp is mocked.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../config/openai', () => ({})); // no OpenAI calls here
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

const { runInternationalNotifications, localDaysUntil, expiryReminderFor } = require('../cron/internationalNotifications');
const { sendTemplateMessage } = require('../services/whatsappService');

jest.setTimeout(60000);

const DAY = 24 * 60 * 60 * 1000;
const min = (d, m) => new Date(new Date(d).getTime() + m * 60000);

describe('local calendar days to expiry', () => {
  test('counts the learner\'s calendar dates, not 24-hour blocks or UTC dates', () => {
    const now = new Date('2026-11-04T14:00:00Z'); // 09:00 Toronto, Wed 4 Nov
    expect(localDaysUntil(new Date('2026-11-12T04:59:00Z'), now, 'America/Toronto')).toBe(7); // 23:59 Wed 11 Nov local (12 Nov in UTC)
    expect(localDaysUntil(new Date('2026-11-12T05:00:00Z'), now, 'America/Toronto')).toBe(8); // 00:00 Thu 12 Nov local
    expect(localDaysUntil(new Date('2026-11-04T23:00:00Z'), now, 'America/Toronto')).toBe(0); // later today
    // Vancouver evening expiry is the next UTC date but the same local date
    expect(localDaysUntil(new Date('2026-11-08T07:30:00Z'), new Date('2026-11-04T17:00:00Z'), 'America/Vancouver')).toBe(3);
  });

  test('same bands as the IST job: 7-day for 4-7 days, 3-day for 0-3 days', () => {
    expect(expiryReminderFor(8)).toBeNull();
    expect(expiryReminderFor(7).template).toBe('expiry_reminder_7_days_new');
    expect(expiryReminderFor(4).template).toBe('expiry_reminder_7_days_new');
    expect(expiryReminderFor(3).template).toBe('expiry_reminder_3_days_new');
    expect(expiryReminderFor(0).template).toBe('expiry_reminder_3_days_new');
    expect(expiryReminderFor(-1)).toBeNull();
  });
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const Lesson = require('../models/Lesson');
const { runExpiryReminderJob } = require('../cron/expiryReminder');
const { runWeeklySummaryJob } = require('../cron/weeklySummary');

// Sunday 8 Nov 2026, 18:00 in each zone
const SUNDAY_6PM = {
  'America/Toronto': '2026-11-08T23:00:00Z',
  'America/Vancouver': '2026-11-09T02:00:00Z', // Monday in UTC
  'Europe/London': '2026-11-08T18:00:00Z',
  'America/St_Johns': '2026-11-08T21:30:00Z',
  'Asia/Kathmandu': '2026-11-08T12:15:00Z'
};
const TORONTO_9AM = new Date('2026-11-04T14:00:00Z');

let n = 0;
async function learner(overrides = {}) {
  n++;
  return User.create({
    name: `L${n}`,
    phone: `1416555${String(3000 + n)}`,
    isActive: true,
    state: 'READY',
    currentDay: 9,
    streak: 4,
    timezone: 'America/Toronto',
    expiryDate: new Date('2026-12-30T00:00:00Z'),
    ...overrides
  });
}
async function activeThisWeek(user, at) {
  await Lesson.create({ userId: user._id, day: 8, level: 'beginner', lessonText: 'x', status: 'completed', completedAt: new Date(new Date(at).getTime() - 2 * DAY) });
}
const sent = () => sendTemplateMessage.mock.calls.map(c => [c[0], c[1], c[2]]);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('international weekly and expiry notifications (real MongoDB)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/intl_notify_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
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
    await Promise.all([User.deleteMany({}), Lesson.deleteMany({})]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
  });

  test('flag off: no local sends; the IST jobs keep international learners', async () => {
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    const t = await learner({ expiryDate: new Date(Date.now() + 5 * DAY) }); // the IST job uses the real clock
    expect(await runInternationalNotifications({ now: TORONTO_9AM })).toEqual({ skipped: true, reason: 'disabled' });
    await runExpiryReminderJob();
    expect(sent().map(s => s[0])).toContain(t.phone);
  });

  test.each(Object.entries(SUNDAY_6PM))('weekly summary at Sunday 18:00 local in %s, once', async (timezone, at) => {
    const u = await learner({ timezone });
    await activeThisWeek(u, at);
    await runInternationalNotifications({ now: min(at, -1) }); // 17:59
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalNotifications({ now: new Date(at) });
    await runInternationalNotifications({ now: min(at, 5) });
    mockRedis.store.clear(); // restart
    await runInternationalNotifications({ now: min(at, 10) });
    expect(sent()).toEqual([[u.phone, 'weekly_summary_new', [u.name, '1', '4']]]);
    expect(await User.findById(u._id).lean()).toMatchObject({ weeklyCompletedCount: 0, currentDay: 9 });
  });

  test('weekly: Toronto DST start Sunday (8 Mar) fires at 18:00 EDT; next Sunday fires again', async () => {
    const u = await learner();
    await activeThisWeek(u, '2026-03-08T22:00:00Z');
    await runInternationalNotifications({ now: new Date('2026-03-08T22:00:00Z') });
    await activeThisWeek(u, '2026-03-15T22:00:00Z');
    await runInternationalNotifications({ now: new Date('2026-03-15T22:00:00Z') });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
  });

  test('weekly: inactive week sends nothing; missed run catches up until 21:00 only', async () => {
    await learner(); // no activity
    const active = await learner();
    const at = SUNDAY_6PM['America/Toronto'];
    await activeThisWeek(active, at);
    await runInternationalNotifications({ now: min(at, 3 * 60) }); // 21:00 - too late
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalNotifications({ now: min(at, 150) }); // 20:30 catch-up
    expect(sent().map(s => s[0])).toEqual([active.phone]);
  });

  test('expiry: 7-day reminder at 09:00 local, once; 3-day reminder later; flags as before', async () => {
    const u = await learner({ expiryDate: new Date('2026-11-11T20:00:00Z') }); // Wed 11 Nov 15:00 Toronto = 7 local days
    await runInternationalNotifications({ now: min(TORONTO_9AM, -1) }); // 08:59
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalNotifications({ now: TORONTO_9AM });
    await runInternationalNotifications({ now: min(TORONTO_9AM, 5) });
    mockRedis.store.clear(); // restart drops the daily marker; the claimed flag still prevents a resend
    await runInternationalNotifications({ now: min(TORONTO_9AM, 10) });
    expect(sent()).toEqual([[u.phone, 'expiry_reminder_7_days_new', [u.name]]]);
    expect((await User.findById(u._id)).sevenDayReminderSent).toBe(true);

    await runInternationalNotifications({ now: min(TORONTO_9AM, 4 * 24 * 60) }); // Sun 8 Nov = 3 days left
    expect(sent()[1]).toEqual([u.phone, 'expiry_reminder_3_days_new', [u.name]]);
  });

  test('expiry: no reminder after the actual expiry instant, for inactive users, or after 12:00 local', async () => {
    await learner({ expiryDate: min(TORONTO_9AM, -60) }); // expired at 08:00 today
    await learner({ isActive: false, expiryDate: min(TORONTO_9AM, 3 * 24 * 60) });
    const late = await learner({ expiryDate: min(TORONTO_9AM, 3 * 24 * 60) });
    await runInternationalNotifications({ now: min(TORONTO_9AM, 3 * 60) }); // 12:00
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await runInternationalNotifications({ now: TORONTO_9AM });
    expect(sent().map(s => s[0])).toEqual([late.phone]);
  });

  test('expiry: a failed send is retried the next local day, not every 5 minutes', async () => {
    const u = await learner({ expiryDate: min(TORONTO_9AM, 5 * 24 * 60) });
    sendTemplateMessage.mockRejectedValueOnce(new Error('WhatsApp 503'));
    expect(await runInternationalNotifications({ now: TORONTO_9AM })).toMatchObject({ expirySent: 0, failed: 1 });
    expect((await User.findById(u._id)).sevenDayReminderSent).toBe(false);
    await runInternationalNotifications({ now: min(TORONTO_9AM, 5) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    await runInternationalNotifications({ now: min(TORONTO_9AM, 24 * 60) });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect((await User.findById(u._id)).sevenDayReminderSent).toBe(true);
  });

  test('expiry: renewal resets the flags (existing payment code) and reminders resume near the new expiry', async () => {
    const u = await learner({ expiryDate: min(TORONTO_9AM, 5 * 24 * 60), sevenDayReminderSent: true });
    await runInternationalNotifications({ now: TORONTO_9AM });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    await User.updateOne({ _id: u._id }, { expiryDate: min(TORONTO_9AM, 35 * 24 * 60), sevenDayReminderSent: false, threeDayReminderSent: false });
    await runInternationalNotifications({ now: min(TORONTO_9AM, 24 * 60) });
    expect(sendTemplateMessage).not.toHaveBeenCalled(); // 34 days left
    await runInternationalNotifications({ now: min(TORONTO_9AM, 29 * 24 * 60) }); // 6 local days left
    expect(sent()).toEqual([[u.phone, 'expiry_reminder_7_days_new', [u.name]]]);
  });

  test('concurrent instances send once; Redis outage sends nothing', async () => {
    await learner({ expiryDate: min(TORONTO_9AM, 5 * 24 * 60) });
    await Promise.all([runInternationalNotifications({ now: TORONTO_9AM }), runInternationalNotifications({ now: TORONTO_9AM })]);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);

    await learner({ expiryDate: min(TORONTO_9AM, 6 * 24 * 60) });
    mockRedis.store.clear();
    mockRedis.fail = true;
    expect(await runInternationalNotifications({ now: min(TORONTO_9AM, 5) })).toMatchObject({ skipped: true });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  test('half-hour and 45-minute zones: expiry at their 09:00', async () => {
    const stJohns = await learner({ timezone: 'America/St_Johns', expiryDate: new Date('2026-11-09T15:00:00Z') });
    const ktm = await learner({ timezone: 'Asia/Kathmandu', expiryDate: new Date('2026-11-09T06:00:00Z') });
    await runInternationalNotifications({ now: new Date('2026-11-04T03:14:00Z') }); // Kathmandu 08:59
    await runInternationalNotifications({ now: new Date('2026-11-04T03:15:00Z') }); // Kathmandu 09:00
    await runInternationalNotifications({ now: new Date('2026-11-04T12:30:00Z') }); // St John's 09:00
    expect(sent().map(s => s[0])).toEqual([ktm.phone, stJohns.phone]);
  });

  test('flag on: India / no-timezone learners stay on the IST jobs only, international only on local', async () => {
    const india = await learner({ timezone: undefined, phone: '919876511111', expiryDate: new Date(Date.now() + 5 * DAY) });
    const pune = await learner({ timezone: 'Asia/Kolkata', phone: '919876511112', expiryDate: new Date(Date.now() + 5 * DAY) });
    const toronto = await learner({ expiryDate: new Date(Date.now() + 5 * DAY) });
    await activeThisWeek(india, new Date());
    await activeThisWeek(toronto, new Date());

    await runExpiryReminderJob();
    await runWeeklySummaryJob();
    const istPhones = sent().map(s => s[0]);
    expect(istPhones).toEqual(expect.arrayContaining([india.phone, pune.phone]));
    expect(istPhones).not.toContain(toronto.phone);
  });

  test('IST expiry job: no "expires soon" reminder once the plan has actually expired', async () => {
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    await learner({ timezone: undefined, phone: '919876522222', expiryDate: new Date(Date.now() - 60 * 1000) });
    const live = await learner({ timezone: undefined, phone: '919876522223', expiryDate: new Date(Date.now() + 2 * DAY) });
    await runExpiryReminderJob();
    expect(sent().map(s => s[0])).toEqual([live.phone]);
  });
});
