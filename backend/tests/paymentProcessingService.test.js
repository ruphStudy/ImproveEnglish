jest.mock('../models/User', () => {
  const MockUser = jest.fn();
  MockUser.findOne = jest.fn();
  return MockUser;
});

jest.mock('../models/PendingOrder', () => ({
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(),
  find: jest.fn()
}));

jest.mock('../models/PaymentHistory', () => ({
  create: jest.fn(),
  findOne: jest.fn()
}));

jest.mock('../models/Log', () => ({
  create: jest.fn()
}));

jest.mock('../services/promoService', () => ({
  markPromoAsUsed: jest.fn(),
  validatePromoCode: jest.fn()
}));

const User = require('../models/User');
const PendingOrder = require('../models/PendingOrder');
const PaymentHistory = require('../models/PaymentHistory');
const Log = require('../models/Log');
const { markPromoAsUsed } = require('../services/promoService');
const { processSuccessfulPayment, reconcileStuckPendingOrders } = require('../services/paymentProcessingService');

// Both the payment.captured webhook and the Payment Link callback call
// processSuccessfulPayment with the same shape of arguments, so exercising
// this function directly covers "webhook duplicate", "callback duplicate",
// "webhook before callback" and "callback before webhook" - the two callers
// are just different entry points into this single idempotent gate.

function makeClaimedOrder(overrides = {}) {
  const order = {
    _id: 'order1',
    razorpayOrderId: 'order_rzp_1',
    name: 'Rajesh',
    phone: '919000000001',
    email: 'rajesh@example.com',
    level: 'beginner',
    planDuration: 30,
    amountPaise: 50000,
    promoCode: null,
    originalAmountPaise: null,
    discountAmountPaise: 0,
    utmSource: null,
    status: 'processing',
    ...overrides
  };
  order.save = jest.fn().mockResolvedValue(order);
  return order;
}

function makeExistingUser(overrides = {}) {
  const user = {
    _id: 'user1',
    name: 'Rajesh',
    phone: '919000000001',
    email: 'rajesh@example.com',
    level: 'beginner',
    isActive: true,
    state: 'READY',
    currentDay: 24,
    streak: 9,
    lessonText: 'old lesson',
    lessonCompleted: true,
    expiryDate: null,
    sevenDayReminderSent: true,
    threeDayReminderSent: true,
    ...overrides
  };
  user.save = jest.fn().mockResolvedValue(user);
  return user;
}

beforeEach(() => {
  jest.clearAllMocks();
  Log.create.mockResolvedValue({});
  markPromoAsUsed.mockResolvedValue({ success: true });
  PendingOrder.updateOne.mockResolvedValue({});
});

describe('processSuccessfulPayment - amount validation', () => {
  test('rejects when captured amount does not match expected amount', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created', amountPaise: 50000 });

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_1',
      paymentMethod: 'upi',
      amountPaidPaise: 40000
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('AMOUNT_MISMATCH');
    expect(PendingOrder.findOneAndUpdate).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
  });
});

describe('processSuccessfulPayment - idempotency / claim', () => {
  test('a duplicate/concurrent call finds no claimable order and is reported as alreadyProcessed', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created' });
    PendingOrder.findOneAndUpdate.mockResolvedValue(null); // someone else already claimed it
    PendingOrder.findById.mockReturnValue({ lean: () => Promise.resolve({ status: 'paid' }) });

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_1',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(PaymentHistory.create).not.toHaveBeenCalled();
  });

  test('webhook-then-callback: second call for the same order is a no-op (no double side effects)', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created' });
    const claimed = makeClaimedOrder({ status: 'processing' });

    // First call ("webhook"): claim succeeds
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(claimed);
    User.findOne.mockResolvedValueOnce(null); // brand new user
    const newUserInstance = { save: jest.fn().mockResolvedValue(true) };
    User.mockImplementationOnce(function (data) {
      Object.assign(this, data, newUserInstance);
    });
    PaymentHistory.create.mockResolvedValueOnce({});

    const first = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_1',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });
    expect(first.alreadyProcessed).toBe(false);
    expect(claimed.save).toHaveBeenCalled(); // status flipped to 'paid'

    // Second call ("callback"): claim fails because status is no longer 'created'
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(null);
    PendingOrder.findById.mockReturnValue({ lean: () => Promise.resolve({ status: 'paid' }) });

    const second = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_1',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(second.alreadyProcessed).toBe(true);
    // Side effects (user creation, payment history) only happened once
    expect(PaymentHistory.create).toHaveBeenCalledTimes(1);
  });

  test('a real processing failure releases the claim so the retry can complete safely', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created' });
    const claimed = makeClaimedOrder({ status: 'processing' });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);
    User.findOne.mockRejectedValue(new Error('Mongo connection lost'));

    await expect(processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_1',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    })).rejects.toThrow('Mongo connection lost');

    expect(PendingOrder.updateOne).toHaveBeenCalledWith(
      { _id: claimed._id, status: 'processing' },
      { $set: { status: 'created' } }
    );
  });
});

describe('processSuccessfulPayment - new user', () => {
  test('creates a new active user starting at Day 1', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created', level: 'beginner', planDuration: 30 });
    const claimed = makeClaimedOrder({ status: 'processing', level: 'beginner', planDuration: 30 });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);
    User.findOne.mockResolvedValue(null);

    let createdUser;
    User.mockImplementation(function (data) {
      Object.assign(this, data);
      this.save = jest.fn().mockResolvedValue(this);
      createdUser = this;
    });
    PaymentHistory.create.mockResolvedValue({});

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_new',
      paymentMethod: 'card',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result.success).toBe(true);
    expect(result.isNewUser).toBe(true);
    expect(createdUser.state).toBe('READY');
    expect(createdUser.currentDay).toBe(1);
    expect(createdUser.isActive).toBe(true);
    expect(claimed.status).toBe('paid');
  });
});

describe('processSuccessfulPayment - renewal / upgrade level rules', () => {
  test('same-level renewal preserves currentDay, streak and lesson progress', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created', level: 'beginner', planDuration: 90 });
    const claimed = makeClaimedOrder({ status: 'processing', level: 'beginner', planDuration: 90 });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);

    const existingUser = makeExistingUser({ level: 'beginner', currentDay: 24, streak: 9 });
    User.findOne.mockResolvedValue(existingUser);
    PaymentHistory.create.mockResolvedValue({});

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_renew',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result.levelChanged).toBe(false);
    expect(existingUser.currentDay).toBe(24); // untouched
    expect(existingUser.streak).toBe(9); // untouched
    expect(existingUser.state).toBe('READY');
    expect(existingUser.isActive).toBe(true);
  });

  test('level-changing upgrade resets currentDay to 1 and state to READY but preserves streak', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created', level: 'intermediate', planDuration: 90 });
    const claimed = makeClaimedOrder({ status: 'processing', level: 'intermediate', planDuration: 90 });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);

    const existingUser = makeExistingUser({ level: 'beginner', currentDay: 24, streak: 9, state: 'READY' });
    User.findOne.mockResolvedValue(existingUser);
    PaymentHistory.create.mockResolvedValue({});

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_upgrade',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result.levelChanged).toBe(true);
    expect(existingUser.level).toBe('intermediate');
    expect(existingUser.currentDay).toBe(1);
    expect(existingUser.state).toBe('READY');
    expect(existingUser.streak).toBe(9); // preserved
    expect(existingUser.lessonCompleted).toBe(false);
  });

  test('expired-user renewal extends from now, active-user renewal extends from existing expiry', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    // Expired user
    let pendingOrder = makeClaimedOrder({ status: 'created', level: 'beginner', planDuration: 30 });
    let claimed = makeClaimedOrder({ status: 'processing', level: 'beginner', planDuration: 30 });
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(claimed);
    const expiredUser = makeExistingUser({ level: 'beginner', expiryDate: past, isActive: false });
    User.findOne.mockResolvedValueOnce(expiredUser);
    PaymentHistory.create.mockResolvedValue({});

    let result = await processSuccessfulPayment({
      pendingOrder, razorpayPaymentId: 'pay_exp', paymentMethod: 'upi', amountPaidPaise: pendingOrder.amountPaise
    });
    const daysFromNow = Math.round((result.newExpiryDate - Date.now()) / (24 * 60 * 60 * 1000));
    expect(daysFromNow).toBeGreaterThanOrEqual(29);
    expect(daysFromNow).toBeLessThanOrEqual(30);

    // Active user with future expiry
    pendingOrder = makeClaimedOrder({ status: 'created', level: 'beginner', planDuration: 30 });
    claimed = makeClaimedOrder({ status: 'processing', level: 'beginner', planDuration: 30 });
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(claimed);
    const activeUser = makeExistingUser({ level: 'beginner', expiryDate: future, isActive: true });
    User.findOne.mockResolvedValueOnce(activeUser);

    result = await processSuccessfulPayment({
      pendingOrder, razorpayPaymentId: 'pay_active', paymentMethod: 'upi', amountPaidPaise: pendingOrder.amountPaise
    });
    const daysFromFuture = Math.round((result.newExpiryDate - future) / (24 * 60 * 60 * 1000));
    expect(daysFromFuture).toBeGreaterThanOrEqual(29);
    expect(daysFromFuture).toBeLessThanOrEqual(30);
  });
});

describe('processSuccessfulPayment - PaymentHistory duplicate prevention', () => {
  test('a duplicate-key error from PaymentHistory.create is swallowed, payment still finalizes', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created' });
    const claimed = makeClaimedOrder({ status: 'processing' });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);
    User.findOne.mockResolvedValue(null);
    User.mockImplementation(function (data) {
      Object.assign(this, data);
      this.save = jest.fn().mockResolvedValue(this);
    });

    const dupError = new Error('duplicate key');
    dupError.code = 11000;
    PaymentHistory.create.mockRejectedValue(dupError);

    const result = await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_dup',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(false);
    expect(claimed.status).toBe('paid');
  });

  test('a non-duplicate PaymentHistory error propagates and releases the claim', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created' });
    const claimed = makeClaimedOrder({ status: 'processing' });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);
    User.findOne.mockResolvedValue(null);
    User.mockImplementation(function (data) {
      Object.assign(this, data);
      this.save = jest.fn().mockResolvedValue(this);
    });

    PaymentHistory.create.mockRejectedValue(new Error('validation failed'));

    await expect(processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_fail',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    })).rejects.toThrow('validation failed');

    expect(PendingOrder.updateOne).toHaveBeenCalled();
  });
});

describe('processSuccessfulPayment - promo consumption', () => {
  test('marks promo as used exactly once when a promo code was applied', async () => {
    const pendingOrder = makeClaimedOrder({ status: 'created', promoCode: 'SAVE20', discountAmountPaise: 10000, originalAmountPaise: 50000 });
    const claimed = makeClaimedOrder({ status: 'processing', promoCode: 'SAVE20', discountAmountPaise: 10000, originalAmountPaise: 50000 });
    PendingOrder.findOneAndUpdate.mockResolvedValue(claimed);
    User.findOne.mockResolvedValue(null);
    User.mockImplementation(function (data) {
      Object.assign(this, data);
      this._id = 'newUser1';
      this.save = jest.fn().mockResolvedValue(this);
    });
    PaymentHistory.create.mockResolvedValue({});

    await processSuccessfulPayment({
      pendingOrder,
      razorpayPaymentId: 'pay_promo',
      paymentMethod: 'upi',
      amountPaidPaise: pendingOrder.amountPaise
    });

    expect(markPromoAsUsed).toHaveBeenCalledTimes(1);
    expect(markPromoAsUsed).toHaveBeenCalledWith('SAVE20', expect.any(String), expect.any(String), expect.any(String), 500, 100, 500, claimed._id.toString());
  });
});

describe('processSuccessfulPayment - crash then retry safety', () => {
  test('crash after User modification but before PendingOrder reaches paid: retry does not double-extend expiry, double-reset progress, double-consume promo, or duplicate PaymentHistory', async () => {
    const pendingOrder = makeClaimedOrder({
      status: 'created', level: 'intermediate', planDuration: 30,
      promoCode: 'SAVE20', discountAmountPaise: 10000, originalAmountPaise: 50000
    });
    const sharedUser = makeExistingUser({ level: 'beginner', currentDay: 24, streak: 9, expiryDate: null });

    // --- Attempt 1: claim succeeds, user is mutated (level change + expiry extension),
    // then PaymentHistory.create fails hard - simulates a crash/transient DB failure
    // right after the user write landed but before the order reached 'paid'.
    const claim1 = makeClaimedOrder({ status: 'processing', level: 'intermediate', planDuration: 30, promoCode: 'SAVE20' });
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(claim1);
    User.findOne.mockResolvedValueOnce(sharedUser);
    PaymentHistory.create.mockRejectedValueOnce(new Error('disk full'));

    await expect(processSuccessfulPayment({
      pendingOrder, razorpayPaymentId: 'pay_crash', paymentMethod: 'upi', amountPaidPaise: pendingOrder.amountPaise
    })).rejects.toThrow('disk full');

    expect(sharedUser.lastAppliedPaymentId).toBe('pay_crash');
    expect(sharedUser.level).toBe('intermediate');
    expect(sharedUser.currentDay).toBe(1); // reset once, level changed
    const expiryAfterAttempt1 = sharedUser.expiryDate;
    expect(expiryAfterAttempt1).toBeTruthy();
    expect(markPromoAsUsed).not.toHaveBeenCalled(); // crash happened before this step

    // --- Attempt 2: reconciliation released the order back to 'created', a retry arrives
    // for the SAME Razorpay payment ID. User.findOne now returns the already-mutated user.
    const claim2 = makeClaimedOrder({ status: 'processing', level: 'intermediate', planDuration: 30, promoCode: 'SAVE20' });
    PendingOrder.findOneAndUpdate.mockResolvedValueOnce(claim2);
    User.findOne.mockResolvedValueOnce(sharedUser);
    PaymentHistory.create.mockResolvedValueOnce({}); // succeeds this time
    sharedUser.save.mockClear();

    const result2 = await processSuccessfulPayment({
      pendingOrder, razorpayPaymentId: 'pay_crash', paymentMethod: 'upi', amountPaidPaise: pendingOrder.amountPaise
    });

    expect(result2.success).toBe(true);
    expect(result2.alreadyProcessed).toBe(false);
    expect(sharedUser.save).not.toHaveBeenCalled(); // user mutation skipped on retry
    expect(sharedUser.expiryDate).toBe(expiryAfterAttempt1); // NOT extended a second time
    expect(sharedUser.currentDay).toBe(1); // not reset again
    expect(PaymentHistory.create).toHaveBeenCalledTimes(2); // 1st failed, 2nd (retry) succeeded
    expect(markPromoAsUsed).toHaveBeenCalledTimes(1); // consumed exactly once, on the retry
    expect(claim2.status).toBe('paid');
  });
});

describe('reconcileStuckPendingOrders', () => {
  test('finalizes directly to paid when PaymentHistory already exists (does not replay business logic)', async () => {
    const stuckOrder = makeClaimedOrder({ status: 'processing', razorpayPaymentId: 'pay_done' });
    PendingOrder.find.mockResolvedValue([stuckOrder]);
    PaymentHistory.findOne.mockResolvedValue({ razorpayPaymentId: 'pay_done' });

    const result = await reconcileStuckPendingOrders(15);

    expect(stuckOrder.status).toBe('paid');
    expect(result).toEqual({ checked: 1, released: 0, finalized: 1 });
  });

  test('releases back to created when no PaymentHistory exists yet', async () => {
    const stuckOrder = makeClaimedOrder({ status: 'processing', razorpayPaymentId: 'pay_incomplete' });
    PendingOrder.find.mockResolvedValue([stuckOrder]);
    PaymentHistory.findOne.mockResolvedValue(null);

    const result = await reconcileStuckPendingOrders(15);

    expect(stuckOrder.status).toBe('created');
    expect(result).toEqual({ checked: 1, released: 1, finalized: 0 });
  });
});
