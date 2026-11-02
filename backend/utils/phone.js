const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

const DEFAULT_COUNTRY = 'IN';

/**
 * Normalizes a phone number to the format WhatsApp uses for msg.from and that
 * User.phone has always stored: E.164 digits WITHOUT the leading "+"
 * (e.g. "919876543210", "14165550123").
 *
 * - "+<cc>..." or "00<cc>..." is parsed as international.
 * - Otherwise it is parsed as a national number of `country` (ISO 3166 alpha-2,
 *   default IN), so Indian numbers beginning with 91 (e.g. 9123456789) are
 *   handled correctly.
 * - Digits that already carry a country code but no "+" (legacy "919876543210")
 *   are accepted too.
 * - When `country` is supplied explicitly (the website form), the parsed number
 *   must belong to that country - with or without "+". This rejects e.g. a US
 *   +1 832 number submitted with Canada selected. Without `country` (WhatsApp
 *   msg.from, admin lookups) any valid number is accepted, as before.
 *
 * Returns null when the number is not valid - callers must reject it rather
 * than guess.
 */
function normalizePhone(input, country) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d{4,17}$/.test(s)) return null;

  let region = DEFAULT_COUNTRY;
  const strict = country !== undefined && country !== null && country !== '';
  if (strict) {
    if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) return null;
    region = country.toUpperCase();
  }

  const international = s.startsWith('+');
  let parsed = parsePhoneNumberFromString(s, international ? undefined : region);
  if ((!parsed || !parsed.isValid()) && !international) {
    parsed = parsePhoneNumberFromString(`+${s}`);
  }
  if (!parsed || !parsed.isValid()) return null;
  if (strict && parsed.country !== region) return null;
  return parsed.number.slice(1);
}

module.exports = { normalizePhone, DEFAULT_COUNTRY };
