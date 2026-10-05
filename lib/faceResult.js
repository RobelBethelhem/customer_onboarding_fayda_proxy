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
const fs = require('fs');
const path = require('path');
const liveness = require('../services/livenessService');

// Key kept on disk when no FACE_RESULT_SECRET / JWT_SECRET is set: survives restarts and is shared
// by every instance of this server (a key made in memory was lost on restart, so customers who
// finished the live check before a restart showed "liveness not verified")
const SECRET_FILE = path.join(__dirname, '..', '.face-result-secret');

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // a saved session can be finished later
const ACTION_LABELS = { mouth: 'Open mouth', turn: 'Head turn' };

function fileSecret() {
  const read = () => { try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { return ''; } };
  let value = read();
  if (value) return value;
  value = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, value, { flag: 'wx', mode: 0o600 }); // 'wx': another instance may have just made it
    console.log(`[Face] Created ${SECRET_FILE} for signing face check results`);
    return value;
  } catch {
    const existing = read();
    if (existing) return existing;
    console.warn('[Face] Could not save the face check key — results stay valid only until this server restarts');
    return value;
  }
}

// Read on first use: routes load before dotenv in server.js. Signing uses the first key; checking
// accepts any of them, so adding FACE_RESULT_SECRET later does not break results signed before.
let keys = null;
function getKeys() {
  if (!keys) {
    keys = [process.env.FACE_RESULT_SECRET, process.env.JWT_SECRET, fileSecret()].filter(Boolean);
  }
  return keys;
}

const clean = (b64) => String(b64 || '').replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
const hash = (b64) => crypto.createHash('sha256').update(clean(b64)).digest('hex');
const b64url = (s) => Buffer.from(s).toString('base64url');
const mac = (body, key = getKeys()[0]) => crypto.createHmac('sha256', key).update(body).digest('base64url');

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
  const signedHere = getKeys().some(key => {
    const expected = mac(body, key);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!signedHere) return null;
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
        reason: !token
          ? 'The live camera check was not completed (camera check unavailable on the device)'
          : payload
            ? 'The live check was done with different photos than the ones submitted'
            : 'The live check result could not be verified (changed, older than 48 hours, or signed with a key this server no longer has) — review the video',
      },
    },
    livenessFrames: [],
  };
}

module.exports = { sign, verifyToken, forApplication, hash, clean };
