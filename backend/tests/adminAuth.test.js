const adminAuth = require('../middleware/adminAuth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('adminAuth middleware', () => {
  const originalSecret = process.env.ADMIN_SECRET;

  afterEach(() => {
    process.env.ADMIN_SECRET = originalSecret;
  });

  test('blocks (503) when ADMIN_SECRET is not configured', () => {
    delete process.env.ADMIN_SECRET;
    const req = { headers: {}, originalUrl: '/api/users' };
    const res = mockRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a request with no admin secret header', () => {
    process.env.ADMIN_SECRET = 'super-secret';
    const req = { headers: {}, originalUrl: '/api/users' };
    const res = mockRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a request with the wrong admin secret', () => {
    process.env.ADMIN_SECRET = 'super-secret';
    const req = { headers: { 'x-admin-secret': 'wrong' }, originalUrl: '/api/users' };
    const res = mockRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts a request with the correct admin secret', () => {
    process.env.ADMIN_SECRET = 'super-secret';
    const req = { headers: { 'x-admin-secret': 'super-secret' }, originalUrl: '/api/users' };
    const res = mockRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
