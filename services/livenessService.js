/**
 * Runs the web app's face check in a worker thread (livenessWorker.js): the face models take
 * seconds per image on the CPU and would otherwise freeze every other request (OTP, eKYC …).
 * One worker, jobs queued; started on first use, restarted if it dies.
 */
const { Worker } = require('worker_threads');
const path = require('path');

const TIMEOUT_MS = Number(process.env.FACE_CHECK_TIMEOUT_MS) || 120000;
const MAX_QUEUE = Number(process.env.FACE_CHECK_MAX_QUEUE) || 20;

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(error) {
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(error);
    pending.delete(id);
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'livenessWorker.js'));
  worker.on('message', ({ id, ok, result, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    if (ok) job.resolve(result);
    else job.reject(new Error(error));
  });
  worker.on('error', (err) => {
    console.error('[Liveness] Worker error:', err);
    failAll(new Error('Face check failed'));
    worker = null;
  });
  worker.on('exit', (code) => {
    if (code !== 0) console.error(`[Liveness] Worker stopped (exit code ${code})`);
    failAll(new Error('Face check stopped'));
    worker = null;
  });
  return worker;
}

function run(task, payload) {
  if (pending.size >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('Face check is busy'), { busy: true }));
  }
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Face check timed out'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, task, payload });
  });
}

module.exports = {
  /** { selfie, frames: [{ action: 'mouth'|'turn', image }], faydaPhoto } → { liveness, match, matchError, ms } */
  verify: (payload) => run('verify', payload),
  /** { selfie, faydaPhoto } → { match, matchError } */
  compare: (payload) => run('compare', payload),
};
