/**
 * Integration tests for free-beta activation against a REAL, throwaway local
 * mongod (standalone - no transactions, matching the no-transaction design).
 * Skipped automatically when no `mongod` binary is available.
 * Never touches MONGO_URI / production data. WhatsApp is mocked.
 */
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({}))); // no real payment calls
jest.mock('../config/openai', () => ({})); // no OpenAI calls in this flow
jest.mock('../services/whatsappService', () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({}),
  sendWhatsAppMessage: jest.fn().mockResolvedValue({})
}));

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const express = require('express');
const mongoose = require('mongoose');

jest.setTimeout(60000);

let mongodPath = null;
try { mongodPath = execSync('command -v mongod', { encoding: 'utf8' }).trim() || null; } catch { mongodPath = null; }
const describeDb = mongodPath ? describe : describe.skip;

const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const PlanMaster = require('../models/PlanMaster');
const PaymentHistory = require('../models/PaymentHistory');
const FreeActivation = require('../models/FreeActivation');
const { sendTemplateMessage } = require('../services/whatsappService');
const { activateFreePromo, reconcileStaleFreeActivations } = require('../services/freePromoService');

let mongod;
let dbPath;
let server;
let baseUrl;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const DAY = 24 * 60 * 60 * 1000;
const base = { name: 'Beta Learner', email: 'beta@example.com', level: 'beginner', planDuration: 30, code: 'BETA100' };
const phoneN = (n) => `9198765${String(10000 + n).slice(-5)}`; // valid Indian mobiles in stored format

async function seedPromo(overrides = {}) {
  await PromoCode.create({
    code: 'BETA100',
    discountType: 'percentage',
    discountValue: 100,
    maxUses: 20,
    perUserLimit: 1,
    validUntil: new Date(Date.now() + 30 * DAY),
    applicableDurations: [30],
    firstTimeOnly: true,
    description: 'Free beta',
    ...overrides
  });
}

describeDb('free beta activation (real MongoDB)', () => {
  beforeAll(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mongo-'));
    const port = await freePort();
    mongod = spawn(mongodPath, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
    const uri = `mongodb://127.0.0.1:${port}/freepromo_test`;
    for (let i = 0; i < 50; i++) {
      try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    // User.phone / PromoCode.code declare both `unique: true` and a plain schema.index()
    // on the same key (pre-existing); MongoDB keeps the unique one and rejects the
    // duplicate, so tolerate that init error and assert the unique indexes below.
    await Promise.allSettled([User.init(), PromoCode.init(), FreeActivation.init(), PaymentHistory.init()]);

    const app = express();
    app.use(express.json());
    app.use('/api/payments', require('../routes/paymentRoutes'));
    app.use('/api/promo', require('../routes/promoRoutes'));
    app.use('/api', require('../routes/userRoutes'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await mongoose.disconnect().catch(() => {});
    if (mongod) mongod.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dbPath, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.WHATSAPP_FREE_WELCOME_TEMPLATE;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all(Object.values(mongoose.connection.collections).map(c => c.deleteMany({})));
    await PlanMaster.create([
      { planName: 'plan30', days: 30, level: 'bigenner', price: 499 },
      { planName: 'plan90', days: 90, level: 'bigenner', price: 1299 }
    ]);
  });

  afterEach(() => jest.restoreAllMocks());

  test('uniqueness indexes the design relies on exist', async () => {
    const uniqueKeys = async (model) => (await model.collection.indexes()).filter(i => i.unique).map(i => Object.keys(i.key).join(','));
    expect(await uniqueKeys(User)).toContain('phone');
    expect(await uniqueKeys(PromoCode)).toContain('code');
    expect(await uniqueKeys(FreeActivation)).toContain('promoCode,phone');
  });

  test('valid 100% code activates a new learner READY, with no payment record', async () => {
    await seedPromo();
    const result = await activateFreePromo({ ...base, phone: phoneN(1) });

    expect(result).toMatchObject({ ok: true, alreadyActivated: false, welcomeStatus: 'skipped_no_template' });
    const user = await User.findOne({ phone: phoneN(1) });
    expect(user).toMatchObject({ isActive: true, state: 'READY', currentDay: 1, level: 'beginner' });
    expect(Math.abs(user.expiryDate - Date.now() - 30 * DAY)).toBeLessThan(60 * 1000);

    const activation = await FreeActivation.findOne({ phone: phoneN(1) });
    expect(activation).toMatchObject({ status: 'activated', source: 'FREE_PROMO', listPriceInr: 499 });
    expect(String(activation.userId)).toBe(String(user._id));

    const promo = await PromoCode.findOne({ code: 'BETA100' });
    expect(promo.currentUses).toBe(1);
    expect(String(promo.usedBy[0].userId)).toBe(String(user._id));
    expect(promo.usedBy[0].finalAmount).toBe(0);

    expect(await PaymentHistory.countDocuments()).toBe(0); // never reported as revenue
    expect(sendTemplateMessage).not.toHaveBeenCalled(); // no paid-success wording without the approved template
  });

  test('repeated activation is idempotent', async () => {
    await seedPromo();
    await activateFreePromo({ ...base, phone: phoneN(2) });
    const again = await activateFreePromo({ ...base, phone: phoneN(2) });

    expect(again).toMatchObject({ ok: true, alreadyActivated: true });
    expect(await User.countDocuments({ phone: phoneN(2) })).toBe(1);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('10 concurrent requests for the same phone create one user and use one slot', async () => {
    await seedPromo();
    const results = await Promise.all(Array.from({ length: 10 }, () => activateFreePromo({ ...base, phone: phoneN(3) })));

    expect(results.every(r => r.ok)).toBe(true);
    expect(results.filter(r => !r.alreadyActivated)).toHaveLength(1);
    expect(await User.countDocuments({ phone: phoneN(3) })).toBe(1);
    expect(await FreeActivation.countDocuments({ phone: phoneN(3) })).toBe(1);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('20 concurrent different phones against maxUses 5: exactly 5 succeed', async () => {
    await seedPromo({ maxUses: 5 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => activateFreePromo({ ...base, phone: phoneN(100 + i) })));

    expect(results.filter(r => r.ok)).toHaveLength(5);
    expect(results.filter(r => !r.ok).every(r => r.status === 409 || r.status === 400)).toBe(true);
    expect(await User.countDocuments()).toBe(5);
    const promo = await PromoCode.findOne({ code: 'BETA100' });
    expect(promo.currentUses).toBe(5);
    expect(promo.usedBy).toHaveLength(5);
  });

  test.each([
    ['expired', { validUntil: new Date(Date.now() - DAY) }, { planDuration: 30 }, 400],
    ['not yet valid', { validFrom: new Date(Date.now() + DAY) }, { planDuration: 30 }, 400],
    ['wrong plan (90-day)', {}, { planDuration: 90 }, 400],
    ['inactive', { isActive: false }, { planDuration: 30 }, 400],
    ['not 100% (50%)', { discountValue: 50 }, { planDuration: 30 }, 400],
    ['fixed amount covering the price', { discountType: 'fixed', discountValue: 10000 }, { planDuration: 30 }, 400],
    ['exhausted', { maxUses: 1, currentUses: 1 }, { planDuration: 30 }, 400]
  ])('%s code is rejected without creating a user', async (_label, promoOverrides, req, status) => {
    await seedPromo(promoOverrides);
    const result = await activateFreePromo({ ...base, ...req, phone: phoneN(4) });
    expect(result).toMatchObject({ ok: false, status });
    expect(await User.countDocuments()).toBe(0);
  });

  test('unknown code is rejected', async () => {
    await seedPromo();
    const result = await activateFreePromo({ ...base, code: 'NOPE', phone: phoneN(5) });
    expect(result.ok).toBe(false);
    expect(await User.countDocuments()).toBe(0);
  });

  test('existing (paid) learner is rejected and their subscription is untouched', async () => {
    await seedPromo();
    const expiry = new Date(Date.now() + 10 * DAY);
    await User.create({ name: 'Paid', phone: phoneN(6), level: 'advanced', isActive: true, state: 'WAITING_START', currentDay: 12, expiryDate: expiry });

    const result = await activateFreePromo({ ...base, phone: phoneN(6) });
    expect(result).toMatchObject({ ok: false, status: 409 });
    const user = await User.findOne({ phone: phoneN(6) });
    expect(user).toMatchObject({ level: 'advanced', state: 'WAITING_START', currentDay: 12 });
    expect(user.expiryDate.getTime()).toBe(expiry.getTime());
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(0);
  });

  test('approved template is sent once; a WhatsApp failure does not reverse activation', async () => {
    await seedPromo();
    process.env.WHATSAPP_FREE_WELCOME_TEMPLATE = 'beta_welcome_free';
    const ok = await activateFreePromo({ ...base, phone: phoneN(7) });
    expect(ok.welcomeStatus).toBe('sent');
    expect(sendTemplateMessage).toHaveBeenCalledWith(phoneN(7), 'beta_welcome_free', expect.any(Array), 'en_US');

    await activateFreePromo({ ...base, phone: phoneN(7) }); // retry sends nothing more
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);

    sendTemplateMessage.mockRejectedValueOnce(new Error('template not approved'));
    const failed = await activateFreePromo({ ...base, phone: phoneN(8) });
    expect(failed).toMatchObject({ ok: true, welcomeStatus: 'failed' });
    expect(await User.findOne({ phone: phoneN(8) })).toMatchObject({ isActive: true, state: 'READY' });
  });

  test('crash after user creation: a retry resumes and finishes without duplicates', async () => {
    await seedPromo();
    const spy = jest.spyOn(FreeActivation, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(activateFreePromo({ ...base, phone: phoneN(9) })).rejects.toThrow('simulated crash');
    spy.mockRestore();
    expect((await FreeActivation.findOne({ phone: phoneN(9) })).status).toBe('reserved');

    const retry = await activateFreePromo({ ...base, phone: phoneN(9) });
    expect(retry).toMatchObject({ ok: true, alreadyActivated: false });
    expect(await User.countDocuments({ phone: phoneN(9) })).toBe(1);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('crash before user creation: reconcile releases the slot, then the learner can retry', async () => {
    await seedPromo({ maxUses: 1 });
    const spy = jest.spyOn(User, 'create').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(activateFreePromo({ ...base, phone: phoneN(10) })).rejects.toThrow('simulated crash');
    spy.mockRestore();
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1); // slot held

    const later = new Date(Date.now() + 60 * 60 * 1000);
    const dry = await reconcileStaleFreeActivations({ now: later });
    expect(dry).toMatchObject({ stale: 1, executed: false, actions: [{ action: 'release' }] });
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1); // dry run changed nothing

    await reconcileStaleFreeActivations({ execute: true, now: later });
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(0);
    expect((await FreeActivation.findOne({ phone: phoneN(10) })).status).toBe('rejected');

    const retry = await activateFreePromo({ ...base, phone: phoneN(10) });
    expect(retry.ok).toBe(true);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('reconcile never releases a reservation that a retry has just refreshed', async () => {
    await seedPromo({ maxUses: 1 });
    const spy = jest.spyOn(User, 'create').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(activateFreePromo({ ...base, phone: phoneN(13) })).rejects.toThrow();
    spy.mockRestore();

    // A retry touches the reservation (heartbeat) moments before reconcile runs.
    const activation = await FreeActivation.findOne({ phone: phoneN(13) });
    await FreeActivation.updateOne({ _id: activation._id, status: 'reserved' }, { $set: { updatedAt: new Date() } });
    await reconcileStaleFreeActivations({ execute: true, olderThanMinutes: 15 });

    expect((await FreeActivation.findById(activation._id)).status).toBe('reserved');
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
    const retry = await activateFreePromo({ ...base, phone: phoneN(13) });
    expect(retry.ok).toBe(true);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('a request whose reservation was released mid-flight fails instead of reporting success', async () => {
    await seedPromo({ maxUses: 1 });
    const realUpdateOne = FreeActivation.updateOne.bind(FreeActivation);
    jest.spyOn(FreeActivation, 'updateOne').mockImplementationOnce(async (filter) => {
      // Reconcile released this reservation just before the heartbeat.
      await FreeActivation.collection.updateOne({ _id: filter._id }, { $set: { status: 'rejected' } });
      await PromoCode.collection.updateOne({ code: 'BETA100' }, { $pull: { usedBy: { freeActivationId: filter._id } }, $inc: { currentUses: -1 } });
      return realUpdateOne(filter, { $set: { updatedAt: new Date() } });
    });

    const result = await activateFreePromo({ ...base, phone: phoneN(14) });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await User.countDocuments({ phone: phoneN(14) })).toBe(0);
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(0);
  });

  test('reconcile keeps the slot if a stalled request created the user after the claim check', async () => {
    await seedPromo();
    const spy = jest.spyOn(FreeActivation, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(activateFreePromo({ ...base, phone: phoneN(15) })).rejects.toThrow();
    spy.mockRestore();
    // Make it look like the user does not exist at reconcile's first check.
    const realFindOne = User.findOne.bind(User);
    jest.spyOn(User, 'findOne').mockImplementationOnce(() => Promise.resolve(null)).mockImplementation(realFindOne);

    await reconcileStaleFreeActivations({ execute: true, now: new Date(Date.now() + 60 * 60 * 1000) });
    expect((await FreeActivation.findOne({ phone: phoneN(15) })).status).toBe('activated');
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  test('reconcile finalizes a reservation whose user was already created', async () => {
    await seedPromo();
    const spy = jest.spyOn(FreeActivation, 'findOneAndUpdate').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(activateFreePromo({ ...base, phone: phoneN(11) })).rejects.toThrow();
    spy.mockRestore();

    await reconcileStaleFreeActivations({ execute: true, now: new Date(Date.now() + 60 * 60 * 1000) });
    const activation = await FreeActivation.findOne({ phone: phoneN(11) });
    expect(activation.status).toBe('activated');
    expect((await PromoCode.findOne({ code: 'BETA100' })).currentUses).toBe(1);
  });

  describe('HTTP endpoints', () => {
    const post = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    test('Canadian learner activates via /activate-free and is stored in WhatsApp format', async () => {
      await seedPromo();
      const res = await post('/api/payments/activate-free', {
        name: 'Maple', email: 'maple@example.com', phone: '(416) 555-0123', country: 'CA', level: 'beginner', planDuration: 30, promoCode: 'beta100'
      });
      expect(res.status).toBe(200);
      expect(await User.findOne({ phone: '14165550123' })).toMatchObject({ state: 'READY' });
    });

    test('/promo/validate ignores client price and reports a free code', async () => {
      await seedPromo();
      const res = await post('/api/promo/validate', { code: 'BETA100', phone: '9876512345', level: 'beginner', planDuration: 30, amount: 1 });
      const body = await res.json();
      expect(body).toMatchObject({ valid: true, isFree: true, promo: { originalAmount: 499, finalAmount: 0 } });
    });

    test('/promo/validate reports covered plan lengths and refuses a 30-day-only code on the 90-day plan', async () => {
      await seedPromo();
      const ok = await (await post('/api/promo/validate', { code: 'BETA100', phone: '9876512345', level: 'beginner', planDuration: 30 })).json();
      expect(ok.applicableDurations).toEqual([30]);
      const ninety = await (await post('/api/promo/validate', { code: 'BETA100', phone: '9876512345', level: 'beginner', planDuration: 90 })).json();
      expect(ninety).toMatchObject({ valid: false, message: 'Promo code not valid for 90-day plan' });
      expect(ninety.promo).toBeUndefined();
    });

    test('/promo/validate gives specific errors for expired, fully used and unknown codes', async () => {
      const check = async code => (await (await post('/api/promo/validate', { code, phone: '9876512345', level: 'beginner', planDuration: 30 })).json());
      await seedPromo({ code: 'OLD100', validUntil: new Date(Date.now() - DAY) });
      await seedPromo({ code: 'FULL100', maxUses: 1, currentUses: 1 });
      expect(await check('OLD100')).toMatchObject({ valid: false, message: 'Promo code has expired' });
      expect(await check('FULL100')).toMatchObject({ valid: false, message: 'Promo code usage limit reached' });
      expect(await check('NOPE')).toMatchObject({ valid: false, message: 'Invalid promo code' });
    });

    test('invalid phone and missing promo are rejected', async () => {
      await seedPromo();
      expect((await post('/api/payments/activate-free', { ...base, promoCode: 'BETA100', phone: '12345' })).status).toBe(400);
      expect((await post('/api/payments/activate-free', { ...base, phone: '9876512345' })).status).toBe(400);
    });

    test('deprecated /api/register stays disabled', async () => {
      const res = await post('/api/register', { name: 'x', phone: '9876543210' });
      expect(res.status).toBe(410);
      expect(await User.countDocuments()).toBe(0);
    });
  });

  test('free activations are not counted as revenue', async () => {
    await seedPromo();
    await activateFreePromo({ ...base, phone: phoneN(12) });
    const { getRevenueAnalytics } = require('../controllers/analyticsController');
    let body;
    await getRevenueAnalytics({}, { json: (b) => { body = b; }, status() { return this; } }, (e) => { throw e; });
    expect(body.data.summary.totalRevenue).toBe(0);
  });
});
