jest.mock('../models/User', () => ({ find: jest.fn(), updateMany: jest.fn() }));

const User = require('../models/User');
const { unblockOnboardingUsers, buildFilter } = require('../scripts/unblockOnboardingUsers');

const NOW = new Date('2026-11-01T00:00:00Z');
const stuckUsers = [
  { _id: 'u1', phone: '919000000001', level: 'beginner', currentDay: 1, expiryDate: new Date('2026-12-01'), onboardingStatus: 'PENDING_GOAL' },
  { _id: 'u2', phone: '919000000002', level: 'advanced', currentDay: 1, expiryDate: new Date('2027-01-01'), onboardingStatus: 'PENDING_ASSESSMENT' }
];

function mockFind(users) {
  User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(users) }) });
}

beforeEach(() => jest.clearAllMocks());

test('filter only targets active, unexpired NEW users with pending onboarding', () => {
  expect(buildFilter(NOW)).toEqual({
    state: 'NEW',
    isActive: true,
    expiryDate: { $gte: NOW },
    onboardingStatus: { $in: ['PENDING_GOAL', 'PENDING_ASSESSMENT'] }
  });
});

test('dry run lists matches and never writes', async () => {
  mockFind(stuckUsers);
  const lines = [];
  const result = await unblockOnboardingUsers({ now: NOW, log: (l) => lines.push(l) });

  expect(result).toEqual({ matched: 2, modified: 0, executed: false });
  expect(User.updateMany).not.toHaveBeenCalled();
  expect(lines.join('\n')).not.toContain('919000000001'); // phones masked
});

test('execute sets READY and unsets onboardingStatus only', async () => {
  mockFind(stuckUsers);
  User.updateMany.mockResolvedValue({ modifiedCount: 2 });
  const result = await unblockOnboardingUsers({ execute: true, now: NOW, log: () => {} });

  expect(result).toEqual({ matched: 2, modified: 2, executed: true });
  expect(User.updateMany).toHaveBeenCalledWith(
    { ...buildFilter(NOW), _id: { $in: ['u1', 'u2'] } },
    { $set: { state: 'READY' }, $unset: { onboardingStatus: '' } }
  );
});

test('execute with no matches is a no-op', async () => {
  mockFind([]);
  const result = await unblockOnboardingUsers({ execute: true, now: NOW, log: () => {} });
  expect(result).toEqual({ matched: 0, modified: 0, executed: true });
  expect(User.updateMany).not.toHaveBeenCalled();
});
