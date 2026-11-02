jest.mock('../models/User', () => ({ create: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/RegistrationLog', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../controllers/paymentController', () => ({
  createOrder: jest.fn((req, res) => res.json({ success: true, orderId: 'order_test' })),
  handleWebhook: jest.fn((req, res) => res.sendStatus(200)),
  getOrderStatus: jest.fn((req, res) => res.json({ success: true })),
  verifyUpgradePayment: jest.fn((req, res) => res.sendStatus(200)),
  reconcileStuckOrders: jest.fn((req, res) => res.sendStatus(200)),
  getPublicConfig: jest.fn((req, res) => res.json({ success: true })),
  activateFree: jest.fn((req, res) => res.json({ success: true }))
}));

const express = require('express');
const User = require('../models/User');
const RegistrationLog = require('../models/RegistrationLog');
const paymentController = require('../controllers/paymentController');
const userRoutes = require('../routes/userRoutes');
const paymentRoutes = require('../routes/paymentRoutes');

let server;
let baseUrl;
const originalSecret = process.env.ADMIN_SECRET;

beforeAll((done) => {
  process.env.ADMIN_SECRET = 'test-admin-secret';
  const app = express();
  app.use(express.json());
  app.use('/api', userRoutes);
  app.use('/api/payments', paymentRoutes);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => {
  process.env.ADMIN_SECRET = originalSecret;
  server.closeAllConnections();
  server.close(() => resolve());
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const post = (path, body, headers = {}) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

describe('deprecated public registration', () => {
  test('unauthenticated POST /api/register is rejected with 410 and creates no user', async () => {
    const res = await post('/api/register', { name: 'Free Rider', phone: '9876543210', email: 'x@example.com' });
    expect(res.status).toBe(410);
    expect((await res.json()).success).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
    expect(RegistrationLog.create).not.toHaveBeenCalled();
  });

  test('an admin secret does not re-enable it either', async () => {
    const res = await post('/api/register', { name: 'A', phone: '9876543210' }, { 'x-admin-secret': 'test-admin-secret' });
    expect(res.status).toBe(410);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('admin user endpoints still require the admin secret', async () => {
    const res = await fetch(`${baseUrl}/api/users`);
    expect(res.status).toBe(401);
  });
});

describe('paid flow routes are unaffected', () => {
  test('public create-order still reaches the payment controller', async () => {
    const res = await post('/api/payments/create-order', { name: 'A', phone: '9876543210', email: 'a@example.com', level: 'beginner', planDuration: 30 });
    expect(res.status).toBe(200);
    expect(paymentController.createOrder).toHaveBeenCalledTimes(1);
  });

  test('Razorpay webhook route still reaches the payment controller', async () => {
    const res = await post('/api/payments/razorpay-webhook', { event: 'payment.captured' });
    expect(res.status).toBe(200);
    expect(paymentController.handleWebhook).toHaveBeenCalledTimes(1);
  });
});
