const { normalizeTimezone, resolveRegistrationTimezone, getUserTimezone, DEFAULT_TIMEZONE } = require('../utils/timezone');

describe('normalizeTimezone', () => {
  test.each([
    ['Asia/Kolkata', 'Asia/Kolkata'],
    ['Asia/Calcutta', 'Asia/Kolkata'], // legacy name some browsers report
    ['America/Toronto', 'America/Toronto'],
    ['America/Vancouver', 'America/Vancouver'],
    ['Europe/London', 'Europe/London'],
    [' america/toronto ', 'America/Toronto'],
    ['US/Pacific', 'America/Los_Angeles'],
    ['UTC', 'UTC']
  ])('%p -> %p', (input, expected) => {
    expect(normalizeTimezone(input)).toBe(expected);
  });

  test.each([
    ['Mars/Phobos'], ['Toronto'], ['+05:30'], ['GMT+5:30'], ['IST'], [''], ['   '],
    ['../../etc/passwd'], ['America/Toronto; DROP'], ['A/'.repeat(40)], [null], [undefined], [42], [{ $ne: '' }]
  ])('rejects %p', (input) => {
    expect(normalizeTimezone(input)).toBeNull();
  });
});

describe('resolveRegistrationTimezone', () => {
  test('a submitted zone wins over the phone country (travellers, +1 numbers)', () => {
    expect(resolveRegistrationTimezone('America/Vancouver', 'CA')).toEqual({ timezone: 'America/Vancouver' });
    expect(resolveRegistrationTimezone('Europe/London', 'IN')).toEqual({ timezone: 'Europe/London' });
  });

  test('an invalid submitted zone is an error, never silently replaced', () => {
    expect(resolveRegistrationTimezone('Not/AZone', 'IN')).toEqual({ error: 'Please choose a valid time zone' });
  });

  test('missing zone: single-zone countries fall back, multi-zone countries stay unset', () => {
    expect(resolveRegistrationTimezone(undefined, 'IN')).toEqual({ timezone: 'Asia/Kolkata' });
    expect(resolveRegistrationTimezone('', 'GB')).toEqual({ timezone: 'Europe/London' });
    for (const c of ['CA', 'US', 'AU', '', undefined]) {
      expect(resolveRegistrationTimezone(undefined, c)).toEqual({ timezone: undefined });
    }
  });
});

test('existing users without a stored timezone are treated as Asia/Kolkata', () => {
  expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
  expect(getUserTimezone({})).toBe('Asia/Kolkata');
  expect(getUserTimezone({ timezone: null })).toBe('Asia/Kolkata');
  expect(getUserTimezone({ timezone: 'America/Toronto' })).toBe('America/Toronto');
});
