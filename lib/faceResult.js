/**
 * The web app's face check result, signed by this server, so the application carries the server's
 * verdict — never a score the browser made up.
 *
 *  /api/face/verify-liveness  → sign(): HMAC over the result and the SHA-256 of the selfie, frames
 *                               and Fayda photo it was computed from
 *  /api/flexcube/create-customer → forApplication(): accept the result only for those same images;
 *                               otherwise (web) compare the selfie with the Fayda photo again now
 */
const crypto = require('crypto');
const liveness = require('../services/livenessService');

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // a saved session can be finished later
const ACTION_LABELS = { mouth: 'Open mouth', turn: 'Head turn' };

let secret = null;
function getSecret() {
  // Read on first use: routes load before dotenv in server.js
  if (!secret) {
    secret = process.env.FACE_RESULT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      console.warn('[Face] FACE_RESULT_SECRET / JWT_SECRET not set — face check results stay valid only until this server restarts');
    }
  }
  return secret;
}

const clean = (b64) => String(b64 || '').replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
const hash = (b64) => crypto.createHash('sha256').update(clean(b64)).digest('hex');
const b64url = (s) => Buffer.from(s).toString('base64url');
const mac = (body) => crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');

function sign({ selfie, frames, faydaPhoto, result }) {
  const body = b64url(JSON.stringify({
    v: 1,
    iat: Date.now(),
    sh: hash(selfie),
    fh: faydaPhoto ? hash(faydaPhoto) : '',
    fr: (frames || []).map(f => ({ a: f.action, h: hash(f.image) })),
    liveness: result.liveness,
    match: result.match,
    matchError: result.matchError,
  }));
  return `${body}.${mac(body)}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = mac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.v !== 1 || Date.now() - payload.iat > MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Face fields for the dashboard: { faceMatchScore, faceVerification, livenessFrames }, or null to
 * leave the application as it is (mobile app and other channels keep their own results).
 */
async function forApplication(body) {
  const selfie = clean(body.selfiePhoto);
  const fayda = clean(body.faydaPhoto);
  const token = body.faceVerificationToken;
  const payload = token ? verifyToken(token) : null;

  if (payload && selfie && payload.sh === hash(selfie) && (!payload.fh || payload.fh === hash(fayda))) {
    const frames = (Array.isArray(body.livenessFrames) ? body.livenessFrames : [])
      .filter(f => f && typeof f.image === 'string' && payload.fr.some(x => x.a === f.action && x.h === hash(f.image)))
      .slice(0, 4)
      .map(f => ({ action: f.action, label: ACTION_LABELS[f.action] || f.action, image: clean(f.image) }));
    return {
      faceMatchScore: payload.match ? payload.match.similarity : 0,
      faceVerification: {
        verifiedBy: 'server',
        method: 'web-liveness-v1',
        checkedAt: new Date(payload.iat).toISOString(),
        liveness: payload.liveness,
        match: payload.match,
        matchError: payload.matchError,
      },
      livenessFrames: frames,
    };
  }

  if ((body.channel || 'mobile_app') !== 'web' || !selfie || !fayda) return null;

  // Web application without a valid live-check result: compare the faces now, liveness not verified
  let match = null;
  let matchError;
  try {
    ({ match, matchError } = await liveness.compare({ selfie, faydaPhoto: fayda }));
  } catch (e) {
    matchError = `Face comparison failed: ${e.message}`;
  }
  return {
    faceMatchScore: match ? match.similarity : 0,
    faceVerification: {
      verifiedBy: 'server',
      method: 'compare-at-submission',
      checkedAt: new Date().toISOString(),
      match,
      matchError,
      liveness: {
        performed: false,
        passed: false,
        reason: token
          ? 'The live check result does not belong to this application'
          : 'The live camera check was not completed (camera check unavailable on the device)',
      },
    },
    livenessFrames: [],
  };
}

module.exports = { sign, verifyToken, forApplication, hash, clean };
