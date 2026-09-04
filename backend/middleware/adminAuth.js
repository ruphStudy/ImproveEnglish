/**
 * Guards internal operational/admin endpoints (user/log/analytics listing,
 * manual cron triggers, payment reconciliation) that have no other auth.
 * Public webhook and frontend-facing payment/plan/promo-validate endpoints
 * must never use this.
 *
 * Fails CLOSED: if ADMIN_SECRET isn't configured, the route is blocked
 * rather than silently left open - a missing env var should be loud, not
 * a security hole.
 */
module.exports = function adminAuth(req, res, next) {
  const configuredSecret = process.env.ADMIN_SECRET;

  if (!configuredSecret) {
    console.error('[AdminAuth] ADMIN_SECRET is not configured - blocking admin route:', req.originalUrl);
    return res.status(503).json({ success: false, message: 'Admin access not configured' });
  }

  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== configuredSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  next();
};
