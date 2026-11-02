const { normalizePhone } = require('../utils/phone');

describe('normalizePhone - India (default) and backward compatibility', () => {
  test.each([
    ['9876543210', '919876543210'],
    ['98765 43210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['919876543210', '919876543210'], // already stored format (existing users / WhatsApp msg.from)
    ['00919876543210', '919876543210'],
    ['09876543210', '919876543210'], // trunk 0
    ['9123456789', '919123456789'] // national number starting with 91 - previously stored without the country code
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
    expect(normalizePhone(input, 'IN')).toBe(expected);
  });

  test('every format of the same Indian number maps to one stored value (duplicate-safe)', () => {
    const variants = ['9876543210', '+919876543210', '919876543210', '0091 98765 43210', '(+91) 98765-43210'];
    expect(new Set(variants.map(v => normalizePhone(v, 'IN')))).toEqual(new Set(['919876543210']));
  });
});

describe('normalizePhone - international', () => {
  test.each([
    ['4165550123', 'CA', '14165550123'],
    ['(416) 555-0123', 'CA', '14165550123'],
    ['+1 416 555 0123', 'CA', '14165550123'],
    ['2025550147', 'US', '12025550147'],
    ['07400 123456', 'GB', '447400123456'],
    ['+447911123456', undefined, '447911123456'],
    ['0412 345 678', 'AU', '61412345678'],
    ['050 123 4567', 'AE', '971501234567'],
    ['+65 8123 4567', undefined, '6581234567'],
    ['14165550123', undefined, '14165550123'] // WhatsApp msg.from style: digits with country code, no country given
  ])('%s (%s) -> %s', (input, country, expected) => {
    expect(normalizePhone(input, country)).toBe(expected);
  });

  test('Canadian and US numbers share +1 and normalize identically', () => {
    expect(normalizePhone('+14165550123')).toBe(normalizePhone('416-555-0123', 'CA'));
  });
});

describe('normalizePhone - explicit country must match the number', () => {
  test('CA and US share +1 but are told apart by area code', () => {
    expect(normalizePhone('+1 416 555 0123', 'CA')).toBe('14165550123');
    expect(normalizePhone('+1 832 555 0123', 'US')).toBe('18325550123');
    expect(normalizePhone('+1 832 555 0123', 'CA')).toBeNull(); // Houston number, Canada selected
    expect(normalizePhone('832 555 0123', 'CA')).toBeNull(); // same without +
    expect(normalizePhone('416 555 0123', 'US')).toBeNull();
  });

  test('+ and national input follow the same rule', () => {
    for (const [input, country] of [['+919876543210', 'IN'], ['9876543210', 'IN'], ['+14165550123', 'CA'], ['4165550123', 'CA']]) {
      expect(normalizePhone(input, country)).not.toBeNull();
    }
    expect(normalizePhone('+919876543210', 'CA')).toBeNull();
    expect(normalizePhone('+14165550123', 'IN')).toBeNull();
    expect(normalizePhone('+447911123456', 'IN')).toBeNull();
  });

  test('existing stored Indian numbers still match with India selected', () => {
    expect(normalizePhone('919876543210', 'IN')).toBe('919876543210');
    expect(normalizePhone('+91 98765 43210', 'IN')).toBe('919876543210');
    expect(normalizePhone('919876543210', 'CA')).toBeNull();
  });

  test('no country given (WhatsApp/admin) still accepts any valid number', () => {
    expect(normalizePhone('+18325550123')).toBe('18325550123');
    expect(normalizePhone('919876543210')).toBe('919876543210');
    expect(normalizePhone('447911123456')).toBe('447911123456');
  });
});

describe('normalizePhone - rejects invalid input instead of guessing', () => {
  test.each([
    [null], [undefined], [''], ['abc'], ['12345'], ['98765'], ['+1 555'], ['+0000000000'],
    ['98765432101234567890'], ['9876543210; DROP'], [{ $gt: '' }]
  ])('%p -> null', (input) => {
    expect(normalizePhone(input, 'IN')).toBeNull();
  });

  test('invalid country codes are rejected', () => {
    expect(normalizePhone('4165550123', 'CAN')).toBeNull();
    expect(normalizePhone('4165550123', { $ne: 1 })).toBeNull();
  });

  test('a number invalid for the selected country is rejected', () => {
    expect(normalizePhone('12345678', 'CA')).toBeNull();
  });
});

describe('auditPhones classification (read-only script)', () => {
  const { classifyStoredPhone } = require('../scripts/auditPhones');

  test('canonical stored phones (existing Indian + international users) are ok', () => {
    expect(classifyStoredPhone('919876543210')).toEqual({ status: 'ok' });
    expect(classifyStoredPhone('14165550123')).toEqual({ status: 'ok' });
  });

  test('legacy 10-digit Indian record is flagged with a suggestion, not changed', () => {
    expect(classifyStoredPhone('9123456789')).toEqual({ status: 'non_canonical', suggested: '919123456789' });
  });

  test('a corrupted number is flagged invalid', () => {
    expect(classifyStoredPhone('9114155')).toEqual({ status: 'invalid' });
  });
});
