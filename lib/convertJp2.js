const sharp = require('sharp');
const { execFile } = require('child_process');
const { writeFileSync, unlinkSync, existsSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const JP2_SIG  = Buffer.from([0x00,0x00,0x00,0x0C,0x6A,0x50,0x20,0x20,0x0D,0x0A,0x87,0x0A]);
const J2K_SIG  = Buffer.from([0xFF,0x4F,0xFF,0x51]);
const JPEG_SIG = Buffer.from([0xFF,0xD8,0xFF]);
const PNG_SIG  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

function findSig(data, sig) {
  for (let i = 0; i <= data.length - sig.length; i++) {
    if (data.subarray(i, i + sig.length).equals(sig)) return i;
  }
  return -1;
}

function decodeWithOpj(buffer) {
  return new Promise((resolve, reject) => {
    const tmpIn  = join(tmpdir(), `jp2_${Date.now()}.jp2`);
    const tmpOut = join(tmpdir(), `jp2_${Date.now()}.png`);
    writeFileSync(tmpIn, buffer);
    execFile('opj_decompress', ['-i', tmpIn, '-o', tmpOut], (err) => {
      existsSync(tmpIn) && unlinkSync(tmpIn);
      if (err) { existsSync(tmpOut) && unlinkSync(tmpOut); return reject(err); }
      const result = readFileSync(tmpOut);
      unlinkSync(tmpOut);
      resolve(result);
    });
  });
}

/**
 * Takes the raw base64 photo from Fayda eKYC and returns a JPEG base64 string
 * that browsers can display directly.
 */
async function convertPhotoToJpeg(base64) {
  const data = Buffer.from(base64, 'base64');

  // 1. JP2 / J2K
  let start = findSig(data, JP2_SIG);
  if (start === -1) start = findSig(data, J2K_SIG);
  if (start !== -1) {
    const slice = data.subarray(start);
    try {
      return (await sharp(slice).jpeg({ quality: 90 }).toBuffer()).toString('base64');
    } catch {
      const png = await decodeWithOpj(slice);
      return (await sharp(png).jpeg({ quality: 90 }).toBuffer()).toString('base64');
    }
  }

  // 2. JPEG — already browser-compatible, just strip any leading garbage
  const jpegAt = findSig(data, JPEG_SIG);
  if (jpegAt !== -1) {
    return jpegAt === 0 ? base64 : data.subarray(jpegAt).toString('base64');
  }

  // 3. PNG
  const pngAt = findSig(data, PNG_SIG);
  if (pngAt !== -1) {
    return pngAt === 0 ? base64 : data.subarray(pngAt).toString('base64');
  }

  // 4. Brute-force
  for (let i = 0; i < data.length - 100; i += 50) {
    try {
      return (await sharp(data.subarray(i)).jpeg({ quality: 90 }).toBuffer()).toString('base64');
    } catch {}
  }

  throw new Error('Could not convert photo to JPEG');
}

module.exports = { convertPhotoToJpeg };