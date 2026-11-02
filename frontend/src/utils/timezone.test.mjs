// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeTimezone,
  detectBrowserTimezone,
  resolveTimezone,
  timezoneOptions,
  lessonTimeLabel,
  nextLocalSevenAm
} from './timezone.js';
import { buildFreeActivationPayload, nextLessonDelivery, formatLessonDelivery } from './freePromo.js';

const fakeIntl = (timeZone) => ({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) });

test('detects India, Toronto, Vancouver and London from the browser', () => {
  assert.equal(detectBrowserTimezone(fakeIntl('Asia/Calcutta')), 'Asia/Kolkata');
  assert.equal(detectBrowserTimezone(fakeIntl('America/Toronto')), 'America/Toronto');
  assert.equal(detectBrowserTimezone(fakeIntl('America/Vancouver')), 'America/Vancouver');
  assert.equal(detectBrowserTimezone(fakeIntl('Europe/London')), 'Europe/London');
});

test('missing or broken browser detection returns null', () => {
  assert.equal(detectBrowserTimezone(fakeIntl(undefined)), null);
  assert.equal(detectBrowserTimezone({ DateTimeFormat: () => { throw new Error('no Intl'); } }), null);
  assert.equal(detectBrowserTimezone({}), null); // Intl without DateTimeFormat
});

test('only valid IANA zones are accepted', () => {
  assert.equal(normalizeTimezone('america/vancouver'), 'America/Vancouver');
  for (const bad of ['Mars/Phobos', 'Toronto', '+05:30', '', null, 7]) assert.equal(normalizeTimezone(bad), null);
});

test('detected zone is used even when it differs from the phone country (+1 and travellers)', () => {
  assert.deepEqual(resolveTimezone({ detected: 'America/Vancouver', country: 'CA' }), { timezone: 'America/Vancouver', source: 'detected', needsChoice: false });
  assert.equal(resolveTimezone({ detected: 'Europe/London', country: 'IN' }).timezone, 'Europe/London');
});

test('optional correction overrides detection; an invalid choice is ignored', () => {
  assert.equal(resolveTimezone({ chosen: 'America/Toronto', detected: 'America/Vancouver', country: 'CA' }).timezone, 'America/Toronto');
  assert.equal(resolveTimezone({ chosen: 'Not/AZone', detected: 'Europe/London', country: 'GB' }).timezone, 'Europe/London');
});

test('without detection: single-zone countries fall back, multi-zone countries must choose', () => {
  assert.deepEqual(resolveTimezone({ detected: null, country: 'IN' }), { timezone: 'Asia/Kolkata', source: 'country', needsChoice: false });
  assert.equal(resolveTimezone({ detected: null, country: 'GB' }).timezone, 'Europe/London');
  for (const country of ['CA', 'US', 'AU', '']) {
    assert.deepEqual(resolveTimezone({ detected: null, country }), { timezone: null, source: null, needsChoice: true });
  }
});

test('picker lists the country zones first, then all zones', () => {
  const { preferred, others } = timezoneOptions('CA', 'America/Toronto');
  assert.deepEqual(preferred.slice(0, 2), ['America/Toronto', 'America/Vancouver']);
  assert.ok(others.includes('Europe/London') && !others.includes('America/Toronto'));
  assert.ok(others.includes('Asia/Kolkata'));
});

test('label never claims local-time delivery while the backend flag is off', () => {
  const sevenIst = new Date('2026-11-04T01:30:00Z');
  assert.equal(lessonTimeLabel('Asia/Kolkata', sevenIst), '7:00 AM (India time)');
  assert.equal(lessonTimeLabel('America/Toronto', sevenIst), '7:00 AM India time (8:30 PM Toronto time)');
  assert.equal(lessonTimeLabel('America/Vancouver', sevenIst), '7:00 AM India time (5:30 PM Vancouver time)');
  assert.equal(lessonTimeLabel('Europe/London', sevenIst), '7:00 AM India time (1:30 AM London time)');
  assert.equal(lessonTimeLabel('America/Toronto', sevenIst, true), '7:00 AM (Toronto local time)');
});

test('free activation and paid order payloads carry the timezone field', async () => {
  const form = { name: 'A', phone: '4165550101', country: 'CA', email: 'a@x.com', level: 'beginner', planDuration: 30 };
  assert.equal(buildFreeActivationPayload(form, { code: 'BETA100' }, 'America/Toronto').timezone, 'America/Toronto');
  const src = (await import('node:fs')).readFileSync(new URL('../pages/BuyPlan.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('createOrder({ ...formData, timezone: tz.timezone })'));
});

test('with local scheduling on, the label promises 7:00 AM in the learner zone; India is unchanged', () => {
  const sevenIst = new Date('2026-11-04T01:30:00Z');
  assert.equal(lessonTimeLabel('America/Vancouver', sevenIst, true), '7:00 AM (Vancouver local time)');
  assert.equal(lessonTimeLabel('Europe/London', sevenIst, true), '7:00 AM (London local time)');
  assert.equal(lessonTimeLabel('Asia/Kolkata', sevenIst, true), '7:00 AM (India time)');
});

test('next local 7:00 AM: before/after 7, DST change days, :30 and :45 offsets', () => {
  const iso = (now, tz) => nextLocalSevenAm(new Date(now), tz).toISOString();
  assert.equal(iso('2026-11-04T11:58:00Z', 'America/Toronto'), '2026-11-04T12:00:00.000Z'); // 06:58 -> today
  assert.equal(iso('2026-11-04T12:02:00Z', 'America/Toronto'), '2026-11-05T12:00:00.000Z'); // 07:02 -> tomorrow
  assert.equal(iso('2026-03-07T20:00:00Z', 'America/Toronto'), '2026-03-08T11:00:00.000Z'); // EST evening -> EDT morning
  assert.equal(iso('2026-10-31T20:00:00Z', 'America/Toronto'), '2026-11-01T12:00:00.000Z'); // EDT evening -> EST morning
  assert.equal(iso('2026-11-04T16:00:00Z', 'America/Vancouver'), '2026-11-05T15:00:00.000Z');
  assert.equal(iso('2026-03-28T20:00:00Z', 'Europe/London'), '2026-03-29T06:00:00.000Z'); // BST starts
  assert.equal(iso('2026-11-04T00:00:00Z', 'America/St_Johns'), '2026-11-04T10:30:00.000Z');
  assert.equal(iso('2026-11-04T00:00:00Z', 'Asia/Kathmandu'), '2026-11-04T01:15:00.000Z');
});

test('success-screen time follows the backend flag', () => {
  const now = new Date('2026-11-04T16:00:00Z'); // 11:00 Toronto
  const local = nextLessonDelivery(now, 'America/Toronto', true);
  assert.equal(local.toISOString(), '2026-11-05T12:00:00.000Z');
  assert.match(formatLessonDelivery(local, 'America/Toronto', true), /7:00 am \(Toronto time\)$/);
  // flag off: India schedule, with the local equivalent
  const ist = nextLessonDelivery(now, 'America/Toronto', false);
  assert.equal(ist.toISOString(), '2026-11-05T01:30:00.000Z');
  assert.match(formatLessonDelivery(ist, 'America/Toronto', false), /\(India time\) = .*8:30 pm \(Toronto time\)$/);
  // Pune is identical either way
  assert.equal(nextLessonDelivery(now, 'Asia/Kolkata', true).toISOString(), ist.toISOString());
});

test('registration page reads the flag from the backend, not a hardcoded constant', () => {
  const src = readFileSync(new URL('../pages/BuyPlan.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('setLocalScheduling(!!res.data.localLessonScheduling)'));
  assert.ok(src.includes('useState(false); // backend INTERNATIONAL_SCHEDULING_ENABLED'));
  assert.ok(!src.includes('tomorrow at 7:00 AM'));
});
