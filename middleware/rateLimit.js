/**
 * Global rate limit: at most RATE_LIMIT_MAX requests (default 100) per client IP per
 * RATE_LIMIT_WINDOW_MS (default 1 minute), across all routes. In-memory, per process.
 *
 * The client IP is req.ip, which comes from X-Forwarded-For because server.js sets
 * 'trust proxy' (nginx must send X-Forwarded-For). Requests from this machine without
 * X-Forwarded-For are internal server-to-server calls (the Customer Onboarding dashboard
 * saving photos, setting No-Debit, streaming KYC videos) and are not limited.
 */

const hits = new Map(); // ip -> { count, resetAt }
let config;

// Read lazily: server.js loads .env after the routes/middleware are required
function getConfig() {
  if (!config) {
    config = {
      max: Number(process.env.RATE_LIMIT_MAX) || 100,
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    };
    setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of hits) if (now >= entry.resetAt) hits.delete(ip);
    }, config.windowMs).unref();
  }
  return config;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function globalRateLimit(req, res, next) {
  if (!req.headers['x-forwarded-for'] && LOOPBACK.has(req.socket.remoteAddress)) {
    return next(); // internal call from another service on this server
  }

  const { max, windowMs } = getConfig();
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    hits.set(key, entry);
  }
  entry.count++;

  const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
  res.setHeader('RateLimit-Limit', max);
  res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
  res.setHeader('RateLimit-Reset', resetSeconds);

  if (entry.count > max) {
    if (entry.count === max + 1) console.warn(`[RateLimit] ${key} exceeded ${max} requests per ${windowMs / 1000}s`);
    res.setHeader('Retry-After', resetSeconds);
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a minute and try again.',
    });
  }
  next();
}

/**
 * Value for Express 'trust proxy' from TRUST_PROXY: a hop count ("1" = one reverse proxy such
 * as nginx — the default), "true"/"false", or an address list like "loopback, 10.0.0.0/8".
 */
function trustProxySetting(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === '') return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

module.exports = { globalRateLimit, trustProxySetting };
