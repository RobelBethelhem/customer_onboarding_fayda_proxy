// Headers for calls to the Customer Onboarding dashboard: pass the applicant's IP on (req.ip is
// the real client IP once 'trust proxy' is set), so the dashboard's audit log and rate limit see
// the applicant rather than this server.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function forwardedForHeader(req) {
  return req.ip && !LOOPBACK.has(req.ip) ? { 'X-Forwarded-For': req.ip } : {};
}

module.exports = { forwardedForHeader };
