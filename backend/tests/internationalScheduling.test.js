/**
 * International (learner-local 7 AM) lesson scheduling.
 * Unit tests for the local-time window, and integration tests against a REAL
 * throwaway local mongod (skipped when no `mongod` binary is available).
 * Redis and the Bull queue are in-memory fakes that keep their key semantics:
 * SET NX locks and deterministic job ids that make a second add() a no-op.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const mockRedis = { store: new Map(), fail: false };
jest.mock('../config/redisClient', () => ({
  set: jest.fn(async (key, value, ...args) => {
    if (mockRedis.fail) throw new Error('redis down');
    if (args.includes('NX') && mockRedis.store.has(key)) return null;
    mockRedis.store.set(key, value);
    return 'OK';
  }),
  get: jest.fn(async (key) => {
    if (mockRedis.fail) throw new Error('redis down');
    return mockRedis.store.has(key) ? mockRedis.store.get(key) : null;
  }),
  eval: jest.fn(async (script, n, key, token) => {
    if (mockRedis.store.get(key) === token) mockRedis.store.delete(key);
    return 1;
  })
}));

const mockQueue = { jobs: new Map(), failFor: new Set() };
jest.mock('../config/queueConfig', () => ({
  lessonQueue: {
    add: jest.fn(async (data, opts) => {
      if (mockQueue.failFor.has(data.userId)) throw new Error('queue unavailable');
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

const { getLocalLessonWindow, indiaScheduleFilter, isInternationalSchedulingEnabled } = require('../services/lessonScheduling');

jest.setTimeout(60000);

describe('local 7 AM window', () => {
  // [zone, UTC instant of 7:00 local] - includes DST start/end days and :30 / :45 offsets
  test.each([
    ['America/Toronto', '2026-11-04T12:00:00Z'], // EST
    ['America/Toronto', '2026-03-08T11:00:00Z'], // DST starts that night -> EDT 7 AM
    ['America/Toronto', '2026-11-01T12:00:00Z'], // DST ended that night -> EST 7 AM
    ['America/Vancouver', '2026-11-04T15:00:00Z'],
    ['America/Vancouver', '2026-07-01T14:00:00Z'], // PDT
    ['Europe/London', '2026-11-04T07:00:00Z'],
    ['Europe/London', '2026-03-29T06:00:00Z'], // BST starts that night
    ['America/St_Johns', '2026-11-04T10:30:00Z'], // -03:30
    ['Asia/Kathmandu', '2026-11-04T01:15:00Z'], // +05:45
    ['Australia/Adelaide', '2026-11-03T20:30:00Z'] // +10:30 (DST), previous UTC day
  ])('%s is due exactly from 7:00 local (%s)', (zone, sevenLocal) => {
    const at = new Date(sevenLocal);
    expect(getLocalLessonWindow(at, zone)).toMatchObject({ due: true });
    expect(getLocalLessonWindow(at, zone).lessonTime.toISOString()).toBe(at.toISOString());
    expect(getLocalLessonWindow(new Date(at - 60 * 1000), zone).due).toBe(false); // 6:59
    expect(getLocalLessonWindow(new Date(+at + 239 * 60 * 1000), zone).due).toBe(true); // 10:59 catch-up
    expect(getLocalLessonWindow(new Date(+at + 240 * 60 * 1000), zone).due).toBe(false); // 11:00 cut-off
  });

  test('local date follows the learner calendar, not UTC', () => {
    // 20:30 UTC on 3 Nov is already 4 Nov 07:00 in Adelaide
    expect(getLocalLessonWindow(new Date('2026-11-03T20:30:00Z'), 'Australia/Adelaide').localDate).toBe('2026-11-04');
    expect(getLocalLessonWindow(new Date('2026-11-04T03:00:00Z'), 'America/Vancouver').localDate).toBe('2026-11-03');
  });
});

test('the IST lesson cron and noon/evening reminders apply the India/international split', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'cron', f), 'utf8');
  expect(read('dailyLesson.js')).toContain('...(await indiaScheduleFilter())');
  expect(read('lessonReminder.js').split('...(await indiaScheduleFilter())').length - 1).toBe(2);
  expect(read('dailyLesson.js')).toContain("cron.schedule('0 7 * * *'"); // IST schedule unchanged
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const { runInternationalLessonScheduler } = require('../cron/internationalLessonScheduler');
const { lessonQueue } = require('../config/queueConfig');

const DAY = 24 * 60 * 60 * 1000;
const TORONTO_7AM = new Date('2026-11-04T12:00:00Z');
const at = (base, minutes) => new Date(base.getTime() + minutes * 60 * 1000);

let n = 0;
async function learner(overrides = {}) {
  n++;
  return User.create({
    name: `L${n}`,
    phone: `1416555${String(1000 + n)}`,
    isActive: true,
    state: 'READY',
    currentDay: 3,
    expiryDate: new Date(TORONTO_7AM.getTime() + 20 * DAY),
    createdAt: new Date(TORONTO_7AM.getTime() - 2 * DAY),
    ...overrides
  });
}
const queuedIds = () => [...mockQueue.jobs.values()].map(j => j.userId);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('international scheduler (real MongoDB)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/intl_sched_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
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
    mockQueue.jobs.clear();
    mockQueue.failFor.clear();
    lessonQueue.add.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await User.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
  });

  test('flag off (default): scheduler does nothing and the IST cron keeps every user', async () => {
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    expect(isInternationalSchedulingEnabled()).toBe(false);
    await learner({ timezone: 'America/Toronto' });
    expect(await runInternationalLessonScheduler({ now: TORONTO_7AM })).toEqual({ skipped: true, reason: 'disabled' });
    expect(lessonQueue.add).not.toHaveBeenCalled();
    expect(await indiaScheduleFilter()).toEqual({});
  });

  test('flag on: every user is on exactly one path (IST cron vs local scheduler)', async () => {
    const legacy = await learner(); // no timezone - existing users
    const pune = await learner({ timezone: 'Asia/Kolkata' });
    const garbage = await learner({ timezone: 'Not/AZone' }); // cannot be scheduled locally -> stays on IST
    const toronto = await learner({ timezone: 'America/Toronto' });
    const london = await learner({ timezone: 'Europe/London' });

    const ist = await User.find({ ...(await indiaScheduleFilter()), state: 'READY' }).select('_id').lean();
    expect(ist.map(u => String(u._id)).sort()).toEqual([legacy, pune, garbage].map(u => String(u._id)).sort());

    // 7:00 Toronto = 12:00 London: Toronto is due; London is past its 11:00 cut-off
    await runInternationalLessonScheduler({ now: TORONTO_7AM });
    expect(queuedIds()).toEqual([String(toronto._id)]);
    expect(queuedIds()).not.toContain(String(london._id));
  });

  test('Toronto, Vancouver, London each queue at their own 7:00 AM; Pune never via this path', async () => {
    const toronto = await learner({ timezone: 'America/Toronto' });
    const vancouver = await learner({ timezone: 'America/Vancouver' });
    const london = await learner({ timezone: 'Europe/London' });
    await learner({ timezone: 'Asia/Kolkata' });

    await runInternationalLessonScheduler({ now: new Date('2026-11-04T07:00:00Z') }); // London 7:00
    expect(queuedIds()).toEqual([String(london._id)]);
    await runInternationalLessonScheduler({ now: TORONTO_7AM });
    await runInternationalLessonScheduler({ now: new Date('2026-11-04T15:00:00Z') }); // Vancouver 7:00
    expect(queuedIds()).toEqual([london, toronto, vancouver].map(u => String(u._id)));
    expect(lessonQueue.add.mock.calls.every(([, opts]) => /^lesson-[a-f0-9]{24}-day3-2026-11-04$/.test(opts.jobId))).toBe(true);
  });

  test('repeated ticks, restarts and a lost marker never queue the same learner twice', async () => {
    const t = await learner({ timezone: 'America/Toronto' });
    await runInternationalLessonScheduler({ now: TORONTO_7AM });
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 5) }); // marker -> zone skipped
    mockRedis.store.clear(); // restart / marker lost
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 10) });
    expect(mockQueue.jobs.size).toBe(1); // deterministic job id

    // worker has notified: WAITING_START and lastNotificationDate today
    await User.updateOne({ _id: t._id }, { state: 'WAITING_START', lastNotificationDate: at(TORONTO_7AM, 1) });
    mockQueue.jobs.clear(); mockRedis.store.clear();
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 15) });
    expect(mockQueue.jobs.size).toBe(0);
  });

  test('START after the notification makes the learner READY for Day N+1 - not notified again until tomorrow', async () => {
    const t = await learner({ timezone: 'America/Toronto' });
    await User.updateOne({ _id: t._id }, { currentDay: 4, state: 'READY', lastNotificationDate: at(TORONTO_7AM, 1), lastSeenAt: at(TORONTO_7AM, 3) });
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 5) });
    expect(mockQueue.jobs.size).toBe(0);
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 24 * 60) }); // next local 7:00
    expect(queuedIds()).toEqual([String(t._id)]);
    expect([...mockQueue.jobs.keys()][0]).toMatch(/-day4-2026-11-05$/);
  });

  test('missed 7:00 run: catch-up until 11:00 local only, and never for learners who joined after 7:00', async () => {
    const early = await learner({ timezone: 'America/Toronto' });
    await learner({ timezone: 'America/Toronto', createdAt: at(TORONTO_7AM, 60) }); // registered 08:00
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 4 * 60) }); // 11:00 -> too late
    expect(mockQueue.jobs.size).toBe(0);
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 150) }); // 09:30 catch-up
    expect(queuedIds()).toEqual([String(early._id)]);
  });

  test('a failed queue submission leaves the zone open and is retried on the next tick', async () => {
    const a = await learner({ timezone: 'America/Toronto' });
    const b = await learner({ timezone: 'America/Toronto' });
    mockQueue.failFor.add(String(b._id));
    const first = await runInternationalLessonScheduler({ now: TORONTO_7AM });
    expect(first).toMatchObject({ queued: 1, failed: 1 });
    mockQueue.failFor.clear();
    await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 5) });
    expect(queuedIds().sort()).toEqual([String(a._id), String(b._id)].sort());
    expect(mockQueue.jobs.size).toBe(2);
  });

  test('two instances at once: only one runs; Redis down: nobody runs (fail closed)', async () => {
    await learner({ timezone: 'America/Toronto' });
    const [r1, r2] = await Promise.all([
      runInternationalLessonScheduler({ now: TORONTO_7AM }),
      runInternationalLessonScheduler({ now: TORONTO_7AM })
    ]);
    expect([r1, r2].filter(r => r.skipped).length).toBe(1);
    expect(mockQueue.jobs.size).toBe(1);

    mockQueue.jobs.clear(); mockRedis.store.clear(); lessonQueue.add.mockClear();
    mockRedis.fail = true;
    expect(await runInternationalLessonScheduler({ now: at(TORONTO_7AM, 5) })).toMatchObject({ skipped: true });
    expect(lessonQueue.add).not.toHaveBeenCalled();
  });

  test('never queues WAITING_START, IN_LESSON, PAUSED, inactive or expired learners', async () => {
    for (const state of ['WAITING_START', 'IN_LESSON', 'PAUSED', 'COMPLETED_TODAY']) await learner({ timezone: 'America/Toronto', state });
    await learner({ timezone: 'America/Toronto', isActive: false });
    await learner({ timezone: 'America/Toronto', expiryDate: at(TORONTO_7AM, -1) });
    await runInternationalLessonScheduler({ now: TORONTO_7AM });
    expect(lessonQueue.add).not.toHaveBeenCalled();
  });

  test('scheduling only queues - it never changes currentDay, state or lesson data', async () => {
    const t = await learner({ timezone: 'America/Toronto', currentDay: 12 });
    await runInternationalLessonScheduler({ now: TORONTO_7AM });
    const after = await User.findById(t._id).lean();
    expect(after).toMatchObject({ currentDay: 12, state: 'READY' });
  });

  test('half-hour and 45-minute zones are queued at their local 7:00', async () => {
    const stJohns = await learner({ timezone: 'America/St_Johns' });
    const kathmandu = await learner({ timezone: 'Asia/Kathmandu' });
    await runInternationalLessonScheduler({ now: new Date('2026-11-04T10:30:00Z') });
    await runInternationalLessonScheduler({ now: new Date('2026-11-05T01:15:00Z') });
    expect(queuedIds()).toEqual([String(stJohns._id), String(kathmandu._id)]);
  });
});
