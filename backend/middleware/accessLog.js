const morgan = require('morgan');

// Webhook query strings carry credentials (Meta's hub.verify_token /
// hub_verify_token, hub.challenge), so drop the whole query from access logs
// for any webhook path. Matching is case-insensitive because Express routing is.
const WEBHOOK_PATH = /webhook/i;

function sanitizeUrl(url) {
  if (typeof url !== 'string') return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const path = url.slice(0, queryStart);
  return WEBHOOK_PATH.test(path) ? `${path}?[redacted]` : url;
}

morgan.token('url', (req) => sanitizeUrl(req.originalUrl || req.url));

module.exports = function accessLog(options) {
  return morgan('dev', options);
};
module.exports.sanitizeUrl = sanitizeUrl;
