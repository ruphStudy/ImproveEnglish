jest.mock('../config/redisClient', () => ({
  set: jest.fn()
}));

const redisClient = require('../config/redisClient');
const { isDuplicateMessage } = require('../utils/whatsappDedupe');

describe('isDuplicateMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('first delivery of a message ID is accepted (not a duplicate)', async () => {
    redisClient.set.mockResolvedValue('OK'); // SET NX succeeded - key was new

    const result = await isDuplicateMessage('wamid.ABC123');

    expect(result).toBe(false);
    expect(redisClient.set).toHaveBeenCalledWith('wa:msg:wamid.ABC123', '1', 'NX', 'EX', 24 * 60 * 60);
  });

  test('a redelivered message ID is rejected as a duplicate', async () => {
    redisClient.set.mockResolvedValue(null); // SET NX failed - key already existed

    const result = await isDuplicateMessage('wamid.ABC123');

    expect(result).toBe(true);
  });

  test('fails open (treats as not-duplicate) on a transient Redis error', async () => {
    redisClient.set.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await isDuplicateMessage('wamid.ABC123');

    expect(result).toBe(false);
  });

  test('a message with no ID is never treated as a duplicate', async () => {
    const result = await isDuplicateMessage(undefined);

    expect(result).toBe(false);
    expect(redisClient.set).not.toHaveBeenCalled();
  });
});
