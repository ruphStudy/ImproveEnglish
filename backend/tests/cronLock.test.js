jest.mock('../config/redisClient', () => ({
  set: jest.fn(),
  eval: jest.fn(),
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
    redisClient.eval.mockResolvedValue(1);
    Log.create.mockResolvedValue({});
  });

  test('acquired lock releases successfully when token matches (atomic compare-and-delete)', async () => {
    redisClient.set.mockResolvedValue('OK');
    const fn = jest.fn().mockResolvedValue({ done: true });

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ done: true });

    // Acquisition stores a unique token as the value (not a fixed sentinel)
    const [key, token, nxFlag, exFlag, ttl] = redisClient.set.mock.calls[0];
    expect(key).toBe('cron:lock:weekly-summary');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
    expect(nxFlag).toBe('NX');
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(1800);

    // Release uses the Lua compare-and-delete with that exact token, never a raw DEL
    expect(redisClient.del).not.toHaveBeenCalled();
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, evalKey, evalToken] = redisClient.eval.mock.calls[0];
    expect(script).toEqual(expect.stringContaining('redis.call("GET", KEYS[1]) == ARGV[1]'));
    expect(numKeys).toBe(1);
    expect(evalKey).toBe('cron:lock:weekly-summary');
    expect(evalToken).toBe(token);
  });

  test('release does not delete a lock now owned by another token (script returns 0, no error thrown)', async () => {
    redisClient.set.mockResolvedValue('OK');
    redisClient.eval.mockResolvedValue(0); // GET != our token inside the script - someone else owns it now
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await expect(runWithCronLock('weekly-summary', 1800, fn)).resolves.toBe('ok');

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    expect(redisClient.del).not.toHaveBeenCalled();
  });

  test('expired-then-reacquired lock is not deleted by the original (slow) owner', async () => {
    redisClient.set.mockResolvedValue('OK');
    const fn = jest.fn().mockImplementation(async () => {
      // Simulate: TTL expired mid-run and another instance reacquired the
      // key under a different token before this run's release fires.
      redisClient.eval.mockResolvedValueOnce(0);
      return 'slow-run-result';
    });

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(result).toBe('slow-run-result');
    expect(redisClient.eval).toHaveBeenCalledTimes(1); // compare-and-delete attempted, correctly no-op'd
    expect(redisClient.del).not.toHaveBeenCalled(); // never a blind delete
  });

  test('skips the job when another instance already holds the lock', async () => {
    redisClient.set.mockResolvedValue(null); // NX failed - already locked
    const fn = jest.fn();

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, lockKey: 'weekly-summary' });
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'CRON_LOCK_SKIP' }));
    expect(redisClient.eval).not.toHaveBeenCalled(); // never held it, nothing to release
  });

  test('callback exception still attempts ownership-safe release', async () => {
    redisClient.set.mockResolvedValue('OK');
    const fn = jest.fn().mockRejectedValue(new Error('job failed'));

    await expect(runWithCronLock('weekly-summary', 1800, fn)).rejects.toThrow('job failed');

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const [, , evalKey, evalToken] = redisClient.eval.mock.calls[0];
    expect(evalKey).toBe('cron:lock:weekly-summary');
    expect(typeof evalToken).toBe('string');
  });

  test('fails open (runs the job anyway) on a Redis error acquiring the lock', async () => {
    redisClient.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const fn = jest.fn().mockResolvedValue('ran');

    const result = await runWithCronLock('weekly-summary', 1800, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe('ran');
  });
});
