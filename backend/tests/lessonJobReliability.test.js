/**
 * Daily lesson job-id reliability: Bull keeps completed/failed jobs and treats
 * add() with a retained job id as a no-op. These tests run the REAL worker,
 * IST cron and international scheduler against a throwaway local mongod
 * (skipped without a `mongod` binary). The queue fake keeps Bull's id
 * semantics (retained ids are never re-run); OpenAI and WhatsApp are mocked.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({}),
  sendWhatsAppMessage: jest.fn().mockResolvedValue({})
}));
jest.mock('../services/lessonGeneratorV2', () => ({
  generateLesson: jest.fn(async () => ({
    lessonJson: { title: 'Lesson' },
    lessonText: 'Lesson text',
    scenarioType: 'everyday',
    generationVersion: 'v3',
    validationStatus: 'valid',
    vocabList: []
  }))
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

// Bull semantics that matter here: one job per id, retained after completion or
// failure (an add() with a retained id returns it without running it again).
const mockQueue = { jobs: new Map(), down: false };
jest.mock('../config/queueConfig', () => ({
  lessonQueue: {
    add: jest.fn(async (data, opts) => {
      if (mockQueue.down) throw new Error('Redis connection lost');
      if (!mockQueue.jobs.has(opts.jobId)) mockQueue.jobs.set(opts.jobId, { data, state: 'waiting' });
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

const { lessonJobId } = require('../services/lessonScheduling');

jest.setTimeout(60000);

test('job id: same learner, day and scheduling date dedupe; another date does not', () => {
  const u = { _id: 'abc', currentDay: 4 };
  expect(lessonJobId(u, '2026-11-04')).toBe('lesson-abc-day4-2026-11-04');
  expect(lessonJobId(u, '2026-11-04')).toBe(lessonJobId(u, '2026-11-04'));
  expect(lessonJobId(u, '2026-11-05')).not.toBe(lessonJobId(u, '2026-11-04'));
});

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const Lesson = require('../models/Lesson');
const CurriculumTopic = require('../models/CurriculumTopic');
const { processLessonJob } = require('../workers/lessonWorker');
const { runDailyLessonJob } = require('../cron/dailyLesson');
const { runInternationalLessonScheduler } = require('../cron/internationalLessonScheduler');
const { sendTemplateMessage } = require('../services/whatsappService');
const { generateLesson } = require('../services/lessonGeneratorV2');
const { lessonQueue } = require('../config/queueConfig');

const DAY = 24 * 60 * 60 * 1000;
const IST_7AM = new Date('2026-11-04T01:30:00Z');
const TORONTO_7AM = new Date('2026-11-04T12:00:00Z');

/** Runs waiting jobs like the Bull worker: up to 3 attempts, then retained as failed. */
async function drainQueue() {
  for (const job of mockQueue.jobs.values()) {
    if (job.state !== 'waiting') continue;
    job.state = 'active';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        job.result = await processLessonJob(job.data.userId);
        job.state = 'completed';
        break;
      } catch (err) {
        job.state = attempt === 3 ? 'failed' : 'active';
      }
    }
  }
}

/** Runs the IST cron as if it were `now` (only Date is faked). */
async function runIstCron(now) {
  jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
  try {
    await runDailyLessonJob();
  } finally {
    jest.useRealTimers();
  }
}

let n = 0;
async function learner(overrides = {}) {
  n++;
  return User.create({
    name: `L${n}`,
    phone: `9198765${String(30000 + n)}`,
    isActive: true,
    state: 'READY',
    level: 'beginner',
    currentDay: 2,
    expiryDate: new Date(IST_7AM.getTime() + 30 * DAY),
    createdAt: new Date(IST_7AM.getTime() - 3 * DAY),
    ...overrides
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

describeDb('lesson job reliability (real MongoDB, real worker)', () => {
  let mongod;
  let dbPath;

  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/job_reliability_test`, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
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
    delete process.env.INTERNATIONAL_SCHEDULING_ENABLED;
    mockRedis.store.clear();
    mockQueue.jobs.clear();
    mockQueue.down = false;
    lessonQueue.add.mockClear();
    sendTemplateMessage.mockReset().mockResolvedValue({});
    generateLesson.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all([User.deleteMany({}), Lesson.deleteMany({}), CurriculumTopic.deleteMany({})]);
    await CurriculumTopic.create([1, 2, 3].map(day => ({
      level: 'beginner', day, month: 1, theme: 'T', title: `Topic ${day}`, grammarFocus: 'G', difficultyTag: 'easy'
    })));
  });

  afterEach(() => jest.restoreAllMocks());

  test('skipped job retained while the learner stays READY: next day is not blocked', async () => {
    const u = await learner({ currentDay: 3 });
    await CurriculumTopic.deleteMany({ day: 3 }); // day 1: no topic -> job completes as "skipped"
    await runIstCron(IST_7AM);
    await drainQueue();
    expect([...mockQueue.jobs.values()][0]).toMatchObject({ state: 'completed', result: { status: 'skipped', reason: 'no_topic' } });
    expect((await User.findById(u._id)).state).toBe('READY');

    await CurriculumTopic.create({ level: 'beginner', day: 3, month: 1, theme: 'T', title: 'Topic 3', grammarFocus: 'G', difficultyTag: 'easy' });
    await runIstCron(new Date(IST_7AM.getTime() + DAY));
    await drainQueue();
    expect(mockQueue.jobs.size).toBe(2); // the old id would have been a silent no-op
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect((await User.findById(u._id)).state).toBe('WAITING_START');
  });

  test('failed job retained (WhatsApp down all attempts): next day retries and reuses the lesson - one AI call', async () => {
    const u = await learner();
    sendTemplateMessage.mockRejectedValue(new Error('WhatsApp 503'));
    await runIstCron(IST_7AM);
    await drainQueue();
    expect([...mockQueue.jobs.values()][0].state).toBe('failed');
    expect(await User.findById(u._id)).toMatchObject({ state: 'READY', currentDay: 2 });
    expect(await Lesson.countDocuments({ userId: u._id })).toBe(1);

    sendTemplateMessage.mockReset().mockResolvedValue({});
    await runIstCron(new Date(IST_7AM.getTime() + DAY));
    await drainQueue();
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(generateLesson).toHaveBeenCalledTimes(1); // reused, not regenerated
    expect(await User.findById(u._id)).toMatchObject({ state: 'WAITING_START', currentDay: 2 });
    expect((await Lesson.findOne({ userId: u._id })).status).toBe('notified');
  });

  test('WhatsApp failure then success within the same job: one lesson, one AI call, one successful send', async () => {
    const u = await learner();
    sendTemplateMessage.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({});
    await runIstCron(IST_7AM);
    await drainQueue();
    expect(generateLesson).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2); // 1 failed attempt + 1 success
    expect(await Lesson.countDocuments({ userId: u._id })).toBe(1);
    expect((await User.findById(u._id)).state).toBe('WAITING_START');
  });

  test('existing waiting job and repeated cron runs the same day: one job, one notification', async () => {
    await learner();
    await runIstCron(IST_7AM);
    await runIstCron(new Date(IST_7AM.getTime() + 60 * 1000)); // second instance / manual re-run
    expect(lessonQueue.add).toHaveBeenCalledTimes(2);
    expect(mockQueue.jobs.size).toBe(1);
    await drainQueue();
    await runIstCron(new Date(IST_7AM.getTime() + 2 * 60 * 1000)); // after notification: not READY
    await drainQueue();
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  test('worker crash after the lesson was marked notified but before the user was saved: state repaired, no resend', async () => {
    const u = await learner();
    const notifiedAt = new Date(IST_7AM.getTime() + 30 * 1000);
    await Lesson.create({ userId: u._id, day: 2, level: 'beginner', lessonText: 'x', status: 'notified', notifiedAt });
    await runIstCron(new Date(IST_7AM.getTime() + DAY));
    await drainQueue();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(generateLesson).not.toHaveBeenCalled();
    const after = await User.findById(u._id);
    expect(after).toMatchObject({ state: 'WAITING_START', currentDay: 2 });
    expect(after.lastNotificationDate.getTime()).toBe(notifiedAt.getTime());
  });

  test('worker crash before sending (lesson saved as generated): restart reuses the lesson', async () => {
    const u = await learner();
    await Lesson.create({ userId: u._id, day: 2, level: 'beginner', lessonText: 'saved', status: 'generated' });
    await runIstCron(IST_7AM);
    await drainQueue();
    expect(generateLesson).not.toHaveBeenCalled();
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(await Lesson.countDocuments({ userId: u._id })).toBe(1);
  });

  test('a Day-1 lesson from the previous level is not reused after a level-changing upgrade', async () => {
    const u = await learner({ currentDay: 1 });
    await Lesson.create({ userId: u._id, day: 1, level: 'intermediate', lessonText: 'old level', status: 'completed' });
    await runIstCron(IST_7AM);
    await drainQueue();
    expect(generateLesson).toHaveBeenCalledTimes(1);
    expect(await Lesson.countDocuments({ userId: u._id, level: 'beginner', status: 'notified' })).toBe(1);
  });

  test('international: duplicate ticks and concurrent instances queue once; a failed job does not block the next local day', async () => {
    process.env.INTERNATIONAL_SCHEDULING_ENABLED = 'true';
    const t = await learner({ timezone: 'America/Toronto', phone: '14165559001' });
    const india = await learner();
    sendTemplateMessage.mockRejectedValue(new Error('WhatsApp 503'));
    await Promise.all([
      runInternationalLessonScheduler({ now: TORONTO_7AM }),
      runInternationalLessonScheduler({ now: TORONTO_7AM })
    ]);
    mockRedis.store.clear(); // restart: zone marker lost
    await runInternationalLessonScheduler({ now: new Date(TORONTO_7AM.getTime() + 5 * 60 * 1000) });
    expect(mockQueue.jobs.size).toBe(1);
    expect([...mockQueue.jobs.values()][0].data.userId).toBe(String(t._id)); // Indian learner not on this path
    await drainQueue();
    expect([...mockQueue.jobs.values()][0].state).toBe('failed');

    sendTemplateMessage.mockReset().mockResolvedValue({});
    await runInternationalLessonScheduler({ now: new Date(TORONTO_7AM.getTime() + DAY) });
    await drainQueue();
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(generateLesson).toHaveBeenCalledTimes(1);
    expect((await User.findById(t._id)).state).toBe('WAITING_START');
    expect((await User.findById(india._id)).state).toBe('READY');
  });

  test('Redis temporarily unavailable: nothing is lost, the next tick queues the learner once', async () => {
    process.env.INTERNATIONAL_SCHEDULING_ENABLED = 'true';
    await learner({ timezone: 'Europe/London', phone: '447400123499' });
    const londonSeven = new Date('2026-11-04T07:00:00Z');
    mockQueue.down = true;
    expect(await runInternationalLessonScheduler({ now: londonSeven })).toMatchObject({ queued: 0, failed: 1 });
    mockQueue.down = false;
    await runInternationalLessonScheduler({ now: new Date(londonSeven.getTime() + 5 * 60 * 1000) });
    await drainQueue();
    expect(mockQueue.jobs.size).toBe(1);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
