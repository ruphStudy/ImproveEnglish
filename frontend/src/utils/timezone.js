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

// Every IANA zone (incl. legacy names some browsers report) of the selected
// multi-zone countries - used to check that a detected zone really is in that
// country. +1 numbers can't tell Canada from the US, so the country SELECTION decides.
const COUNTRY_ALL_ZONES = {
  CA: ['America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton', 'America/Goose_Bay', 'America/Toronto',
    'America/Montreal', 'America/Nipigon', 'America/Thunder_Bay', 'America/Iqaluit', 'America/Pangnirtung', 'America/Atikokan',
    'America/Coral_Harbour', 'America/Winnipeg', 'America/Rainy_River', 'America/Resolute', 'America/Rankin_Inlet', 'America/Regina',
    'America/Swift_Current', 'America/Edmonton', 'America/Cambridge_Bay', 'America/Yellowknife', 'America/Inuvik', 'America/Creston',
    'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Whitehorse', 'America/Dawson', 'America/Vancouver', 'America/Blanc-Sablon'],
  US: ['America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Louisville', 'America/Kentucky/Monticello',
    'America/Indiana/Indianapolis', 'America/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indiana/Marengo',
    'America/Indiana/Petersburg', 'America/Indiana/Vevay', 'America/Chicago', 'America/Indiana/Tell_City', 'America/Indiana/Knox',
    'America/Menominee', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah', 'America/Denver',
    'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'America/Juneau', 'America/Sitka',
    'America/Metlakatla', 'America/Yakutat', 'America/Nome', 'America/Adak', 'Pacific/Honolulu'],
  AU: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Lindeman', 'Australia/Adelaide', 'Australia/Broken_Hill',
    'Australia/Perth', 'Australia/Eucla', 'Australia/Darwin', 'Australia/Hobart', 'Australia/Currie', 'Australia/Lord_Howe', 'Antarctica/Macquarie'],
  NZ: ['Pacific/Auckland', 'Pacific/Chatham']
};

/** Is `timezone` a zone of `country`? null when the country is unknown/"Other" (anything goes). */
export function timezoneMatchesCountry(timezone, country) {
  const tz = normalizeTimezone(timezone);
  if (!tz) return false;
  if (SINGLE_ZONE_COUNTRIES[country]) return tz === SINGLE_ZONE_COUNTRIES[country];
  if (COUNTRY_ALL_ZONES[country]) return COUNTRY_ALL_ZONES[country].includes(tz);
  return null;
}

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
 * Final time zone for registration, following the selected phone country:
 * - the learner's own choice wins (kept until the country changes - see keepChosenTimezone);
 * - single-zone country: that zone;
 * - multi-zone country (CA, US, AU, NZ): the browser zone if it is in that country,
 *   otherwise the learner must choose (never "all of Canada is Toronto");
 * - "Other": the browser zone, otherwise the learner must choose.
 * `mismatch` is true when a browser zone was detected but is not in the selected country.
 */
export function resolveTimezone({ chosen, detected, country }) {
  const picked = normalizeTimezone(chosen);
  if (picked) return { timezone: picked, source: 'chosen', needsChoice: false, mismatch: false };
  const found = normalizeTimezone(detected);
  const single = SINGLE_ZONE_COUNTRIES[country];
  if (single) return { timezone: single, source: 'country', needsChoice: false, mismatch: !!found && found !== single };
  const matches = found ? timezoneMatchesCountry(found, country) : false;
  if (found && matches !== false) return { timezone: found, source: 'detected', needsChoice: false, mismatch: false };
  return { timezone: null, source: null, needsChoice: true, mismatch: !!found };
}

/** On a country change: keep the learner's manual choice only if it fits the new country. */
export function keepChosenTimezone(chosen, newCountry) {
  if (!chosen) return '';
  if (SINGLE_ZONE_COUNTRIES[newCountry]) return '';
  return timezoneMatchesCountry(chosen, newCountry) === false ? '' : chosen;
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
