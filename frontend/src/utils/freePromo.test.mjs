// Run with: npm test (Node's built-in test runner - no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isPlanEligible,
  checkoutMode,
  promoResetAction,
  buildFreeActivationPayload,
  friendlyPromoError,
  runExclusive,
  nextLessonDelivery
} from './freePromo.js';

const quote30 = { code: 'BETA100', originalAmount: 499, isFree: true, applicableDurations: [30], planDuration: 30 };
const form = { name: 'Asha', phone: '9876543210', country: 'IN', email: 'a@example.com', level: 'beginner', planDuration: 30 };

test('valid free promo for the selected plan switches checkout to free', () => {
  assert.equal(checkoutMode(quote30, 30), 'free');
  assert.equal(checkoutMode(null, 30), 'paid');
  assert.equal(checkoutMode({ ...quote30, isFree: false }, 30), 'paid');
});

test('a 30-day-only code is never applied to 90- or 365-day plans', () => {
  assert.equal(isPlanEligible(quote30, 30), true);
  assert.equal(isPlanEligible(quote30, 90), false);
  assert.equal(isPlanEligible(quote30, 365), false);
  assert.equal(checkoutMode(quote30, 90), 'paid'); // stale quote after a plan change
  assert.equal(isPlanEligible({ ...quote30, applicableDurations: null }, 365), true);
});

test('changing phone, country or level clears the code; changing plan re-validates it', () => {
  for (const f of ['phone', 'country', 'level']) assert.equal(promoResetAction(f), 'clear');
  assert.equal(promoResetAction('planDuration'), 'revalidate');
  assert.equal(promoResetAction('name'), null);
  assert.equal(promoResetAction('email'), null);
});

test('invalid, expired and fully used codes get specific friendly errors and keep paid checkout', () => {
  assert.match(friendlyPromoError('Promo code has expired'), /^This promo code has expired\./);
  assert.match(friendlyPromoError('Promo code usage limit reached'), /^This promo code has been fully used\./);
  assert.match(friendlyPromoError('Invalid promo code'), /^This promo code is not valid\./);
  assert.match(friendlyPromoError('Promo code not valid for 90-day plan'), /not valid for the selected plan/);
  assert.match(friendlyPromoError('Free beta access is for new learners only. This WhatsApp number already has an account.'), /new learners only/);
  for (const m of ['Promo code has expired', 'Invalid promo code', undefined]) {
    assert.match(friendlyPromoError(m), /continue with regular payment/);
  }
});

test('double submission runs the activation only once', async () => {
  const ref = { current: false };
  let calls = 0;
  let release;
  const slow = () => new Promise(resolve => { calls++; release = resolve; });
  const first = runExclusive(ref, slow);
  const second = await runExclusive(ref, slow);
  assert.equal(second, false);
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.equal(ref.current, false); // usable again after completion
  await assert.rejects(runExclusive(ref, async () => { throw new Error('network'); }));
  assert.equal(ref.current, false); // released after a failure too
});

test('free activation payload carries the code but never an amount', () => {
  const payload = buildFreeActivationPayload({ ...form, amount: 0, price: 0 }, quote30);
  assert.deepEqual(payload, { ...form, promoCode: 'BETA100' });
  assert.equal('amount' in payload || 'price' in payload || 'finalAmount' in payload, false);
});

test('free activation bypasses Razorpay and payment order creation', () => {
  const src = readFileSync(new URL('../pages/BuyPlan.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('const handleFreeActivation');
  const body = src.slice(start, src.indexOf('const handlePayment', start));
  assert.ok(body.includes('activateFree('));
  assert.ok(!/createOrder|Razorpay\(|razorpay\.open/.test(body));
  // and the paid handler refuses to run while a free code is applied
  const paid = src.slice(src.indexOf('const handlePayment'), src.indexOf('createOrder(formData)'));
  assert.match(paid, /checkoutMode\(promo, formData\.planDuration\) === 'free'\) return;/);
});

test('first lesson is the next 7:00 AM India time', () => {
  // 06:00 IST -> same day 07:00 IST
  assert.equal(nextLessonDelivery(new Date('2026-11-03T00:30:00Z')).toISOString(), '2026-11-03T01:30:00.000Z');
  // 08:00 IST -> next day 07:00 IST
  assert.equal(nextLessonDelivery(new Date('2026-11-03T02:30:00Z')).toISOString(), '2026-11-04T01:30:00.000Z');
});
