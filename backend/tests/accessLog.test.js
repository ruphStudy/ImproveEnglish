const express = require('express');
const accessLog = require('../middleware/accessLog');
const { sanitizeUrl } = accessLog;

const TOKEN = 'test-verify-token-value';
const CHALLENGE = 'challenge-98765';

let server;
let baseUrl;
let logged;

beforeAll((done) => {
  const app = express();
  app.use(accessLog({ stream: { write: (line) => { logged += line; } } }));
  // Stand-in for the verification handler: the leak is in the access log, not the controller.
  app.get('/api/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === TOKEN) return res.status(200).send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  app.get('/api/plans', (req, res) => res.sendStatus(200));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

beforeEach(() => { logged = ''; });

// morgan writes the line when the response finishes, which can be just after the client resolves
async function request(path) {
  const res = await fetch(baseUrl + path);
  await res.text();
  for (let i = 0; i < 50 && !logged; i++) await new Promise((r) => setTimeout(r, 5));
  return res;
}

describe('access log redaction for Meta webhook verification', () => {
  test.each([
    ['valid token', `/api/webhook?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=${CHALLENGE}`, 200],
    ['invalid token', `/api/webhook?hub.mode=subscribe&hub.verify_token=wrong-${TOKEN}&hub.challenge=${CHALLENGE}`, 403],
    ['underscore spelling', `/api/webhook?hub_mode=subscribe&hub_verify_token=${TOKEN}&hub_challenge=${CHALLENGE}`, 403],
    ['trailing slash', `/api/webhook/?hub.verify_token=${TOKEN}&hub.challenge=${CHALLENGE}`, 200],
    ['upper-case path', `/API/WEBHOOK?hub.verify_token=${TOKEN}&hub.challenge=${CHALLENGE}`, 200]
  ])('%s: logs method, path and status but never the token or challenge', async (_label, path, status) => {
    const res = await request(path);
    expect(res.status).toBe(status);
    expect(logged).toContain('GET');
    expect(logged).toMatch(/\/webhook\/?\?\[redacted\]/i);
    expect(logged).toContain(String(status));
    expect(logged).toMatch(/\d+(\.\d+)? ms/);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(CHALLENGE);
    expect(logged).not.toContain('verify_token');
  });

  test('non-webhook routes keep their query string', async () => {
    await request('/api/plans?level=beginner');
    expect(logged).toContain('/api/plans?level=beginner');
  });
});

describe('sanitizeUrl', () => {
  test('redacts webhook queries and leaves other URLs untouched', () => {
    expect(sanitizeUrl('/api/webhook?hub.verify_token=x')).toBe('/api/webhook?[redacted]');
    expect(sanitizeUrl('/api/payments/razorpay-webhook?x=1')).toBe('/api/payments/razorpay-webhook?[redacted]');
    expect(sanitizeUrl('/api/webhook')).toBe('/api/webhook');
    expect(sanitizeUrl('/api/plans?level=a')).toBe('/api/plans?level=a');
  });
});
