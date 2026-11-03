const { checkEmail } = require('../utils/email');

describe('checkEmail', () => {
  test('optional: blank is accepted as "no email" (never a placeholder)', () => {
    for (const v of [undefined, null, '', '   ']) expect(checkEmail(v, { required: false })).toEqual({ email: undefined });
  });
  test('required: blank is an error', () => {
    expect(checkEmail('', { required: true })).toEqual({ error: 'Please enter your email address' });
  });
  test('a supplied address is trimmed and validated', () => {
    expect(checkEmail(' asha@example.com ', { required: false })).toEqual({ email: 'asha@example.com' });
    for (const bad of ['asha', 'asha@', 'a b@x.com', 'x@y', `${'a'.repeat(250)}@x.com`, { $ne: '' }, 42]) {
      expect(checkEmail(bad, { required: false })).toEqual({ error: 'Please enter a valid email address' });
    }
  });
});

test('payment models accept a missing email (WhatsApp upgrade of a learner without one); User has no email index', () => {
  const PendingOrder = require('../models/PendingOrder');
  const PaymentHistory = require('../models/PaymentHistory');
  const User = require('../models/User');
  expect(PendingOrder.schema.path('email').isRequired).toBeFalsy();
  expect(PaymentHistory.schema.path('email').isRequired).toBeFalsy();
  expect(User.schema.indexes().some(([fields]) => 'email' in fields)).toBe(false);
});
