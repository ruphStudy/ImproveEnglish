// Learner time-zone detection for registration. No location permission, IP
// lookup or extra dependency - only the browser's own Intl settings. The
// backend re-validates (backend/utils/timezone.js mirrors these rules).

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const MODERN_NAMES = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Godthab': 'America/Nuuk'
};

// Used only when the browser reports no zone. Keep in sync with the backend.
export const SINGLE_ZONE_COUNTRIES = {
  IN: 'Asia/Kolkata', GB: 'Europe/London', IE: 'Europe/Dublin', AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', OM: 'Asia/Muscat',
  BH: 'Asia/Bahrain', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', DE: 'Europe/Berlin',
  FR: 'Europe/Paris', NP: 'Asia/Kathmandu', BD: 'Asia/Dhaka', LK: 'Asia/Colombo'
};

// Shown first in the picker for countries with several zones.
const COUNTRY_ZONES = {
  CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Regina', 'America/Halifax', 'America/St_Johns'],
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  AU: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Darwin', 'Australia/Hobart'],
  NZ: ['Pacific/Auckland', 'Pacific/Chatham']
};

const SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** Canonical IANA name, or null when not a valid time zone. */
export function normalizeTimezone(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 64 || !SHAPE.test(s)) return null;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
    return MODERN_NAMES[resolved] || resolved;
  } catch {
    return null;
  }
}

/** The browser's time zone, or null when it cannot be detected. */
export function detectBrowserTimezone(intl = globalThis.Intl) {
  try {
    return normalizeTimezone(intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * Final time zone for registration: the learner's choice, else the detected
 * zone, else the country's zone when unambiguous. Otherwise needsChoice -
 * the phone country alone never decides a multi-zone country.
 */
export function resolveTimezone({ chosen, detected, country }) {
  const picked = normalizeTimezone(chosen);
  if (picked) return { timezone: picked, source: 'chosen', needsChoice: false };
  const found = normalizeTimezone(detected);
  if (found) return { timezone: found, source: 'detected', needsChoice: false };
  const fallback = SINGLE_ZONE_COUNTRIES[country];
  if (fallback) return { timezone: fallback, source: 'country', needsChoice: false };
  return { timezone: null, source: null, needsChoice: true };
}

/** Picker options: the country's zones first, then every zone the browser knows. */
export function timezoneOptions(country, current) {
  const preferred = COUNTRY_ZONES[country] || (SINGLE_ZONE_COUNTRIES[country] ? [SINGLE_ZONE_COUNTRIES[country]] : []);
  let all = [];
  try {
    all = Intl.supportedValuesOf('timeZone').map(z => MODERN_NAMES[z] || z);
  } catch {
    all = Object.values(COUNTRY_ZONES).flat().concat(Object.values(SINGLE_ZONE_COUNTRIES));
  }
  const first = [...new Set([current, ...preferred].filter(Boolean))];
  const rest = [...new Set(all)].filter(z => !first.includes(z)).sort();
  return { preferred: first, others: rest };
}

export function timezoneCity(timezone) {
  if (timezone === DEFAULT_TIMEZONE) return 'India';
  return String(timezone || '').split('/').pop().replace(/_/g, ' ');
}

/**
 * Daily lesson time label. `localScheduling` comes from the backend config
 * (INTERNATIONAL_SCHEDULING_ENABLED): while it is off, lessons go out at 7:00 AM
 * India time, so the label says so plus the local equivalent of `at` (a 7:00 AM
 * IST instant) - never a false "7:00 AM local time".
 */
export function lessonTimeLabel(timezone, at, localScheduling = false) {
  if (!timezone || timezone === DEFAULT_TIMEZONE) return '7:00 AM (India time)';
  const city = timezoneCity(timezone);
  if (localScheduling) return `7:00 AM (${city} local time)`;
  const local = at.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  return `7:00 AM India time (${local} ${city} time)`;
}

function zonedParts(date, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(x => [x.type, Number(x.value)]));
  return p;
}

function offsetMs(date, timezone) {
  const p = zonedParts(date, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Next 7:00 AM wall-clock time in `timezone` after `now` (IANA rules incl. DST). Mirrors the backend. */
export function nextLocalSevenAm(now, timezone) {
  const p = zonedParts(now, timezone);
  for (let addDays = 0; addDays < 3; addDays++) {
    const wall = Date.UTC(p.year, p.month - 1, p.day + addDays, 7, 0);
    let utc = wall - offsetMs(new Date(wall), timezone);
    const second = wall - offsetMs(new Date(utc), timezone);
    if (second !== utc) utc = second;
    if (utc > now.getTime()) return new Date(utc);
  }
  return null;
}
