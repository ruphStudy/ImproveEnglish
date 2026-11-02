// IANA time-zone validation for registration (storage only - nothing is
// scheduled by learner time zone yet). Uses Node's built-in Intl/ICU data.

const DEFAULT_TIMEZONE = 'Asia/Kolkata'; // users without a stored timezone

// ICU still reports a few legacy names; store the modern IANA name instead.
const MODERN_NAMES = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Godthab': 'America/Nuuk'
};

// Countries with a single time zone, used only when the browser gives none.
// Multi-zone countries (US, CA, AU, MX, BR, RU, NZ, ...) are deliberately absent.
const SINGLE_ZONE_COUNTRIES = {
  IN: 'Asia/Kolkata',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait',
  OM: 'Asia/Muscat',
  BH: 'Asia/Bahrain',
  SG: 'Asia/Singapore',
  MY: 'Asia/Kuala_Lumpur',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  NP: 'Asia/Kathmandu',
  BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo'
};

// "Area/Location[/Sub]" or UTC - rejects offsets, paths and free text before ICU sees it.
const SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** Canonical IANA name, or null when the value is not a valid time zone. */
function normalizeTimezone(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 64 || !SHAPE.test(s)) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return MODERN_NAMES[resolved] || resolved;
}

/**
 * Time zone to store at registration: the (validated) submitted value, else
 * the country's zone when unambiguous, else undefined (= treated as India).
 * Returns { timezone } or { error } for a value that was sent but is invalid.
 */
function resolveRegistrationTimezone(submitted, country) {
  if (submitted !== undefined && submitted !== null && submitted !== '') {
    const timezone = normalizeTimezone(submitted);
    return timezone ? { timezone } : { error: 'Please choose a valid time zone' };
  }
  const code = typeof country === 'string' ? country.toUpperCase() : '';
  return { timezone: SINGLE_ZONE_COUNTRIES[code] };
}

/** Effective time zone of a learner; existing users have none stored. */
function getUserTimezone(user) {
  return (user && normalizeTimezone(user.timezone)) || DEFAULT_TIMEZONE;
}

/** True for a valid zone other than India - such learners use the local-time scheduler. */
function isInternationalTimezone(timezone) {
  const tz = normalizeTimezone(timezone);
  return !!tz && tz !== DEFAULT_TIMEZONE;
}

/** Wall-clock parts of `date` in `timezone` (IANA rules, so DST and :30/:45 offsets are exact). */
function getZonedParts(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  const n = k => Number(parts[k]);
  return {
    year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second'),
    localDate: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function offsetMs(date, timezone) {
  const p = getZonedParts(date, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of a local wall-clock time in `timezone` (re-checked once across a DST change). */
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timezone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - offsetMs(new Date(wall), timezone);
  const second = wall - offsetMs(new Date(utc), timezone);
  if (second !== utc) utc = second;
  return new Date(utc);
}

module.exports = {
  isInternationalTimezone,
  getZonedParts,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
  SINGLE_ZONE_COUNTRIES,
  normalizeTimezone,
  resolveRegistrationTimezone,
  getUserTimezone
};
