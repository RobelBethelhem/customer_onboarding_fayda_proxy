/**
 * Face check for the web app — runs in a worker thread (see livenessService.js), so the face models
 * never block the Express event loop (on the CPU they take a few seconds per image).
 *
 * verify:  selfie + action frames (open mouth, head turn) + Fayda photo →
 *          liveness (actions really performed by the same person, anti-spoof model) and face match
 * compare: selfie + Fayda photo → face match only
 *
 * Models (in ../models): tinyFaceDetector, faceLandmark68Net, faceRecognitionNet (face-api.js) and
 * antispoof/minifasnet_v2.onnx (MiniFASNet-V2, Apache-2.0, via onnxruntime-node — see its README).
 */
const { parentPort } = require('worker_threads');
const path = require('path');
const faceapi = require('face-api.js');
const canvas = require('canvas');

const { Canvas, Image, ImageData, createCanvas } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODELS_PATH = path.join(__dirname, '..', 'models');
const ANTISPOOF_MODEL = path.join(MODELS_PATH, 'antispoof', 'minifasnet_v2.onnx');

// Detection: tiny detector (≈10× faster than SSD on the CPU); a larger input is tried when it misses
const DETECT_FAST = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });
const DETECT_WIDE = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });

// Same measures as the web app (68-point landmarks), slightly more lenient: the browser already
// required the stricter values before it sent the frames.
const MAR_OPEN = 0.25;         // inner-lip gap / mouth width with the mouth open (browser: 0.30)
const MAR_RISE = 0.10;         // ...and at least this much more open than in the selfie
const YAW_TURN = 0.10;         // head turn vs the selfie (browser: 0.13)
const SAME_PERSON = 0.6;       // descriptor distance between frames of one live session
const MATCH_THRESHOLD = 0.5;   // face match with the Fayda photo (as /api/face/compare)

// Anti-spoof: recorded for KYC; blocks only when ANTISPOOF_ENFORCE=true (calibrate first)
const ANTISPOOF_THRESHOLD = Number(process.env.ANTISPOOF_THRESHOLD) || 0.5;
const ANTISPOOF_ENFORCE = process.env.ANTISPOOF_ENFORCE === 'true';
const ANTISPOOF_SCALE = 2.7;   // crop: 2.7 × the face box (MiniFASNet-V2 "2.7_80x80")
const ANTISPOOF_SIZE = 80;

let modelsReady = null;
function loadModels() {
  if (!modelsReady) {
    modelsReady = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH),
      faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH),
      faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH),
    ]);
  }
  return modelsReady;
}

// ── Anti-spoof model (optional: if onnxruntime-node or the model is missing, the score is null) ──
let ort = null;
let spoofSession = null;
let spoofUnavailable = false;
async function antiSpoofSession() {
  if (spoofSession || spoofUnavailable) return spoofSession;
  try {
    ort = require('onnxruntime-node');
    spoofSession = await ort.InferenceSession.create(ANTISPOOF_MODEL);
  } catch (e) {
    spoofUnavailable = true;
    console.warn(`[Liveness] Anti-spoof model unavailable (${e.message}) — continuing without it`);
  }
  return spoofSession;
}

const softmax = (v) => {
  const max = Math.max(...v);
  const e = v.map(x => Math.exp(x - max));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map(x => x / s);
};

/**
 * Probability (0..1) that the face is a live person, or null if the model is unavailable.
 * Preprocessing as the original Silent-Face-Anti-Spoofing code: crop 2.7 × the face box around its
 * centre (smaller scale / shifted when it would leave the image), resize to 80×80, BGR, raw 0-255.
 * Output: 3 classes, index 1 = real face. (Dividing by 255 makes the output ignore the image —
 * measured: identical logits for different faces.)
 */
async function liveScore(img, box) {
  const session = await antiSpoofSession();
  if (!session) return null;
  const W = img.width;
  const H = img.height;
  const scale = Math.min((H - 1) / box.height, (W - 1) / box.width, ANTISPOOF_SCALE);
  const w = box.width * scale;
  const h = box.height * scale;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let l = cx - w / 2, t = cy - h / 2, r = cx + w / 2, b = cy + h / 2;
  if (l < 0) { r -= l; l = 0; }
  if (t < 0) { b -= t; t = 0; }
  if (r > W - 1) { l -= r - W + 1; r = W - 1; }
  if (b > H - 1) { t -= b - H + 1; b = H - 1; }

  const c = createCanvas(ANTISPOOF_SIZE, ANTISPOOF_SIZE);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, Math.round(l), Math.round(t), Math.max(1, Math.round(r - l)), Math.max(1, Math.round(b - t)), 0, 0, ANTISPOOF_SIZE, ANTISPOOF_SIZE);
  const { data } = ctx.getImageData(0, 0, ANTISPOOF_SIZE, ANTISPOOF_SIZE);
  const n = ANTISPOOF_SIZE * ANTISPOOF_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = data[i * 4 + 2];         // B
    input[n + i] = data[i * 4 + 1];     // G
    input[2 * n + i] = data[i * 4];     // R
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, ANTISPOOF_SIZE, ANTISPOOF_SIZE]) });
  const probs = softmax(Array.from(out[session.outputNames[0]].data));
  return Math.round(probs[1] * 1000) / 1000;
}

// ── Face measures (68-point landmarks) ────────────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Inner-lip gap over mouth width: ~0 closed, larger when open */
const mouthAspectRatio = (mouth) => dist(mouth[14], mouth[18]) / (dist(mouth[0], mouth[6]) || 1);

/** Head turn: nose tip offset along the eye line, over the eye distance (an in-plane tilt does not count) */
function computeYaw(leftEye, rightEye, nose) {
  const lc = mid(leftEye[0], leftEye[3]);
  const rc = mid(rightEye[0], rightEye[3]);
  const dx = rc.x - lc.x;
  const dy = rc.y - lc.y;
  const inter = Math.hypot(dx, dy) || 1;
  const em = mid(lc, rc);
  const tip = nose[3];
  return ((tip.x - em.x) * (dx / inter) + (tip.y - em.y) * (dy / inter)) / inter;
}

function loadImage(base64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable image'));
    img.src = Buffer.from(String(base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  });
}

/** One image: number of faces and, when exactly one, its box, landmark measures and descriptor */
async function analyze(base64) {
  let img;
  try {
    img = await loadImage(base64);
  } catch {
    return { faces: 0, error: 'unreadable image' };
  }
  let found = await faceapi.detectAllFaces(img, DETECT_FAST).withFaceLandmarks().withFaceDescriptors();
  if (!found.length) found = await faceapi.detectAllFaces(img, DETECT_WIDE).withFaceLandmarks().withFaceDescriptors();
  if (found.length !== 1) return { img, faces: found.length };
  const f = found[0];
  const lm = f.landmarks;
  return {
    img,
    faces: 1,
    box: f.detection.box,
    descriptor: f.descriptor,
    mar: mouthAspectRatio(lm.getMouth()),
    yaw: computeYaw(lm.getLeftEye(), lm.getRightEye(), lm.getNose()),
  };
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Best (lowest) distance between the live faces and the Fayda photo */
async function matchWithFayda(live, faydaPhoto) {
  if (!faydaPhoto) return { match: null, matchError: 'No Fayda photo to compare with' };
  const id = await analyze(faydaPhoto);
  if (id.faces !== 1) {
    return { match: null, matchError: id.faces > 1 ? 'More than one face in the Fayda photo' : 'No face found in the Fayda photo' };
  }
  const distance = Math.min(...live.map(a => faceapi.euclideanDistance(a.descriptor, id.descriptor)));
  return {
    match: {
      similarity: Math.round(Math.max(0, Math.min(1, 1 - distance)) * 10000) / 100,
      distance: round(distance),
      threshold: MATCH_THRESHOLD,
      matched: distance < MATCH_THRESHOLD,
      engine: 'face-api.js FaceRecognitionNet',
    },
  };
}

async function verify({ selfie, frames, faydaPhoto }) {
  await loadModels();
  const started = Date.now();
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });

  const self = await analyze(selfie);
  add('one_face', self.faces === 1,
    self.faces === 1 ? 'One face in the selfie' : self.faces > 1 ? 'More than one face in the selfie' : 'No face found in the selfie');

  const analyzed = [];
  for (const f of frames || []) analyzed.push({ action: f.action, ...(await analyze(f.image)) });
  const mouth = analyzed.find(f => f.action === 'mouth');
  const turn = analyzed.find(f => f.action === 'turn');

  const actions = [];
  if (self.faces === 1) {
    if (mouth && mouth.faces === 1) {
      const ok = mouth.mar >= MAR_OPEN && mouth.mar - self.mar >= MAR_RISE;
      add('mouth', ok, `Mouth ${ok ? 'opened' : 'not opened enough'} (${round(self.mar, 2)} → ${round(mouth.mar, 2)})`);
      if (ok) actions.push('mouth');
    } else {
      add('mouth', false, !mouth ? 'No open-mouth frame' : mouth.faces > 1 ? 'Open-mouth frame: more than one face' : 'Open-mouth frame: face not found');
    }
    if (turn && turn.faces === 1) {
      const delta = Math.abs(turn.yaw - self.yaw);
      const ok = delta >= YAW_TURN;
      add('turn', ok, `Head ${ok ? 'turned' : 'not turned enough'} (${round(delta, 2)})`);
      if (ok) actions.push('turn');
    } else {
      add('turn', false, !turn ? 'No head-turn frame' : turn.faces > 1 ? 'Head-turn frame: more than one face' : 'Head-turn frame: face not found');
    }
    const others = analyzed.filter(f => f.faces === 1);
    const worst = others.length ? Math.max(...others.map(f => faceapi.euclideanDistance(self.descriptor, f.descriptor))) : 0;
    add('same_person', others.length > 0 && worst <= SAME_PERSON,
      others.length ? `Same person in every frame (largest distance ${round(worst)})` : 'No frames to compare');
  }

  let score = null;
  if (self.faces === 1) {
    try {
      score = await liveScore(self.img, self.box);
    } catch (e) {
      console.warn('[Liveness] Anti-spoof scoring failed:', e.message);
    }
  }
  const antiSpoof = {
    score,
    threshold: ANTISPOOF_THRESHOLD,
    enforced: ANTISPOOF_ENFORCE,
    model: 'MiniFASNet-V2 (Silent-Face-Anti-Spoofing)',
  };
  if (score !== null) {
    add('anti_spoof', score >= ANTISPOOF_THRESHOLD || !ANTISPOOF_ENFORCE,
      `Anti-spoof score ${score} (live from ${ANTISPOOF_THRESHOLD}${ANTISPOOF_ENFORCE ? '' : ', recorded only'})`);
  }

  const passed = checks.every(c => c.passed);
  const failed = checks.find(c => !c.passed);
  const live = [self, ...analyzed].filter(a => a.faces === 1);
  const { match, matchError } = live.length ? await matchWithFayda(live, faydaPhoto) : { match: null, matchError: 'No face found' };

  return {
    liveness: { performed: true, passed, actions, checks, antiSpoof, reason: failed ? failed.detail : undefined, failed: failed ? failed.name : undefined },
    match,
    matchError,
    ms: Date.now() - started,
  };
}

async function compare({ selfie, faydaPhoto }) {
  await loadModels();
  const self = await analyze(selfie);
  if (self.faces !== 1) return { match: null, matchError: self.faces > 1 ? 'More than one face in the selfie' : 'No face found in the selfie' };
  return matchWithFayda([self], faydaPhoto);
}

// Jobs run one at a time (each is CPU-heavy); the main thread queues them
let chain = Promise.resolve();
parentPort.on('message', ({ id, task, payload }) => {
  chain = chain.then(async () => {
    try {
      const result = task === 'verify' ? await verify(payload) : task === 'compare' ? await compare(payload) : null;
      if (!result) throw new Error(`Unknown task ${task}`);
      parentPort.postMessage({ id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: e.message || String(e) });
    }
  });
});
