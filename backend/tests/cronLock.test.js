jest.mock('../config/redisClient', () => ({
  set: jest.fn(),
  del: jest.fn()
}));
jest.mock('../models/Log', () => ({
  create: jest.fn()
}));

const redisClient = require('../config/redisClient');
const Log = require('../models/Log');
const { runWithCronLock } = require('../utils/cronLock');

describe('runWithCronLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisClient.del.mockResolvedValue(1);
    Log.create.mockResolvedValue({});
  });

  test('acquires the lock, runs the job, and releases the lock', async () => {
    redisClient.set.mockResolvedValue('OK');
    const fn = jest.fn().mockResolvedValue({ done: true });

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(redisClient.set).toHaveBeenCalledWith('cron:lock:weekly-summary', '1', 'NX', 'EX', 1800);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(redisClient.del).toHaveBeenCalledWith('cron:lock:weekly-summary');
    expect(result).toEqual({ done: true });
  });

  test('skips the job when another instance already holds the lock', async () => {
    redisClient.set.mockResolvedValue(null); // NX failed - already locked
    const fn = jest.fn();

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, lockKey: 'weekly-summary' });
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'CRON_LOCK_SKIP' }));
  });

  test('releases the lock even if the job throws', async () => {
    redisClient.set.mockResolvedValue('OK');
    const fn = jest.fn().mockRejectedValue(new Error('job failed'));

    await expect(runWithCronLock('weekly-summary', 1800, fn)).rejects.toThrow('job failed');
    expect(redisClient.del).toHaveBeenCalledWith('cron:lock:weekly-summary');
  });

  test('fails open (runs the job anyway) on a Redis error acquiring the lock', async () => {
    redisClient.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const fn = jest.fn().mockResolvedValue('ran');

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe('ran');
  });
});
