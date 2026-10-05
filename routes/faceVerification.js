/**
 * Face Verification API Routes
 *
 * Endpoints:
 * POST /api/face/detect - Detect faces in image
 * POST /api/face/compare - Compare two faces
 * POST /api/face/liveness - Check liveness challenge
 * POST /api/face/verify - Full verification (detect + compare)
 * POST /api/face/verify-liveness - Web app live check: actions + anti-spoof + match (signed result)
 */

const express = require('express');
const router = express.Router();
const faceApi = require('../services/faceApiService');
const liveness = require('../services/livenessService');
const faceResult = require('../lib/faceResult');
const fs = require('fs');
const path = require('path');

// Rate limiting (simple in-memory, use Redis for production)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  const record = requestCounts.get(ip);

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait before trying again.',
    });
  }

  record.count++;
  next();
}

// Apply rate limiting to all face routes
router.use(rateLimit);

/**
 * POST /api/face/detect
 * Detect faces in an image
 *
 * Body: { image: string (base64) }
 * Returns: Face detection result with landmarks and expressions
 */
router.post('/detect', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        message: 'Image is required (base64 encoded)',
      });
    }

    // Remove data URL prefix if present
    const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');

    // Validate base64
    if (!/^[A-Za-z0-9+/=]+$/.test(cleanImage)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid image format. Expected base64 encoded image.',
      });
    }

    const result = await faceApi.detectFaces(cleanImage);
    res.json(result);

  } catch (error) {
    console.error('Face detection API error:', error);
    res.status(500).json({
      success: false,
      message: 'Face detection service error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/face/compare
 * Compare two faces (selfie vs ID photo)
 *
 * Body: {
 *   selfieImage: string (base64) - Captured selfie
 *   idPhoto: string (base64) - ID photo from Fayda
 * }
 * Returns: Comparison result with match status and similarity score
 */
router.post('/compare', async (req, res) => {
  try {
    const { selfieImage, idPhoto, capturedImage, faydaPhoto } = req.body;

    // Support both naming conventions
    const selfie = selfieImage || capturedImage;
    const idImg = idPhoto || faydaPhoto;

    if (!selfie || !idImg) {
      return res.status(400).json({
        success: false,
        message: 'Both selfieImage and idPhoto are required (base64 encoded)',
      });
    }

    // Remove data URL prefix if present
    const cleanSelfie = selfie.replace(/^data:image\/\w+;base64,/, '');
    const cleanIdPhoto = idImg.replace(/^data:image\/\w+;base64,/, '');

    console.log(`Face comparison request - Selfie size: ${cleanSelfie.length}, ID size: ${cleanIdPhoto.length}`);

    const result = await faceApi.compareFaces(cleanSelfie, cleanIdPhoto);

    console.log(`Face comparison result: matched=${result.matched}, similarity=${result.similarity}%`);

    res.json(result);

  } catch (error) {
    console.error('Face comparison API error:', error);
    res.status(500).json({
      success: false,
      matched: false,
      message: 'Face comparison service error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/face/liveness
 * Check a liveness challenge
 *
 * Body: {
 *   image: string (base64) - Current frame
 *   challenge: string - Challenge type ('smile', 'blink', 'turnLeft', 'turnRight', 'open_mouth')
 * }
 * Returns: Liveness check result
 */
router.post('/liveness', async (req, res) => {
  try {
    const { image, challenge } = req.body;

    if (!image || !challenge) {
      return res.status(400).json({
        success: false,
        message: 'Image and challenge are required',
      });
    }

    const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
    const result = await faceApi.checkLiveness(cleanImage, challenge);

    res.json(result);

  } catch (error) {
    console.error('Liveness check API error:', error);
    res.status(500).json({
      success: false,
      passed: false,
      message: 'Liveness check service error',
    });
  }
});

/**
 * POST /api/face/passive-liveness
 * Passive liveness detection — analyzes multiple frames without user prompts
 *
 * Body: { frames: string[] (array of base64 images, 8-12 frames captured over ~3s) }
 * Returns: Liveness result with confidence score and individual check results
 */
router.post('/passive-liveness', async (req, res) => {
  try {
    const { frames } = req.body;

    if (!frames || !Array.isArray(frames) || frames.length < 3) {
      return res.status(400).json({
        success: false,
        isLive: false,
        confidence: 0,
        message: 'At least 3 frames are required (array of base64 images)',
      });
    }

    // Clean frames
    const cleanFrames = frames.map(f =>
      f.replace(/^data:image\/\w+;base64,/, '')
    );

    console.log(`Passive liveness request - ${cleanFrames.length} frames`);

    const result = await faceApi.checkPassiveLiveness(cleanFrames);

    console.log(`Passive liveness result: isLive=${result.isLive}, confidence=${result.confidence}`);

    res.json(result);

  } catch (error) {
    console.error('Passive liveness API error:', error);
    res.status(500).json({
      success: false,
      isLive: false,
      confidence: 0,
      message: 'Passive liveness service error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/face/verify
 * Full face verification (detection + comparison)
 *
 * Body: {
 *   selfieImage: string (base64) - Captured selfie
 *   idPhoto: string (base64) - ID photo from Fayda
 * }
 * Returns: Complete verification result with all steps
 */
router.post('/verify', async (req, res) => {
  try {
    const { selfieImage, idPhoto, capturedImage, faydaPhoto } = req.body;

    const selfie = selfieImage || capturedImage;
    const idImg = idPhoto || faydaPhoto;

    if (!selfie || !idImg) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: 'Both selfieImage and idPhoto are required',
      });
    }

    const cleanSelfie = selfie.replace(/^data:image\/\w+;base64,/, '');
    const cleanIdPhoto = idImg.replace(/^data:image\/\w+;base64,/, '');

    console.log('Starting full face verification...');

    const result = await faceApi.verifyFace(cleanSelfie, cleanIdPhoto);

    console.log(`Verification complete: verified=${result.verified}, similarity=${result.similarity}%`);

    res.json(result);

  } catch (error) {
    console.error('Face verification API error:', error);
    res.status(500).json({
      success: false,
      verified: false,
      message: 'Face verification service error',
    });
  }
});

/**
 * POST /api/face/occlusion
 * Check for face occlusion (mask, hand covering, etc.)
 *
 * Body: { image: string (base64) }
 * Returns: Occlusion check result with visibility status for each feature
 */
router.post('/occlusion', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        isOccluded: true,
        message: 'Image is required (base64 encoded)',
      });
    }

    // Remove data URL prefix if present
    const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');

    // Validate base64
    if (!/^[A-Za-z0-9+/=]+$/.test(cleanImage)) {
      return res.status(400).json({
        success: false,
        isOccluded: true,
        message: 'Invalid image format. Expected base64 encoded image.',
      });
    }

    console.log('Occlusion check request received');
    const result = await faceApi.checkOcclusion(cleanImage);

    console.log(`Occlusion check result: occluded=${result.isOccluded}, mask=${result.hasMask}`);

    res.json(result);

  } catch (error) {
    console.error('Occlusion check API error:', error);
    res.status(500).json({
      success: false,
      isOccluded: true,
      message: 'Occlusion check service error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/face/upload-video
 * Upload face verification video for manual KYC review
 *
 * Body: {
 *   video: string (base64 encoded video),
 *   selfiePhoto: string (base64 encoded JPEG),
 *   videoMimeType: string (e.g., 'video/webm'),
 *   videoSizeBytes: number
 * }
 * Returns: { success: boolean, videoId: string, message: string }
 */
// What to tell the customer when the live check or the match does not pass
function livenessMessage(result) {
  const l = result.liveness;
  if (!l.passed) {
    switch (l.failed) {
      case 'one_face':
        return /More than one/.test(l.reason || '')
          ? 'Only you should be in front of the camera. Please try again.'
          : 'We could not see your face clearly. Face the camera in good light and try again.';
      case 'mouth': return 'We could not confirm that you opened your mouth. Please try again.';
      case 'turn': return 'We could not confirm the head turn. Turn your head clearly to one side and try again.';
      case 'same_person': return 'Your face changed during the check. Please try again with only you in view.';
      case 'anti_spoof': return 'We could not confirm a live person. Use your own face, not a photo or a screen, in good light.';
      default: return 'The live check did not pass. Please try again.';
    }
  }
  if (!result.match) return 'We could not compare your face with your Fayda ID photo.';
  return result.match.matched ? 'Face verified' : 'Your face does not match your Fayda ID photo.';
}

const MAX_IMAGE_CHARS = 3 * 1024 * 1024; // base64 per image

/**
 * POST /api/face/verify-liveness
 * The web app's live check, verified on the server: the browser guided the customer through the
 * actions (open mouth, turn head) and sends the frames it captured; this checks them again, runs
 * the anti-spoof model and compares the faces with the Fayda photo — in a worker thread.
 *
 * Body: {
 *   selfie: string (base64 JPEG, neutral, facing the camera),
 *   frames: [{ action: 'mouth' | 'turn', image: string (base64 JPEG) }],
 *   faydaPhoto: string (base64 JPEG from eKYC)
 * }
 * Returns: { success, passed, matched, similarity, antiSpoofScore, failed, message, token }
 * `token` (signed) is sent with the application; the dashboard gets the server's result from it.
 */
router.post('/verify-liveness', async (req, res) => {
  const { selfie, frames, faydaPhoto } = req.body || {};
  const okImage = (s) => typeof s === 'string' && s.length > 100 && s.length < MAX_IMAGE_CHARS;
  if (!okImage(selfie)) {
    return res.status(400).json({ success: false, message: 'A selfie image is required' });
  }
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 4 ||
      !frames.every(f => f && ['mouth', 'turn'].includes(f.action) && okImage(f.image))) {
    return res.status(400).json({ success: false, message: 'frames must be 1-4 images with action "mouth" or "turn"' });
  }
  if (faydaPhoto !== undefined && faydaPhoto !== '' && !okImage(faydaPhoto)) {
    return res.status(400).json({ success: false, message: 'Invalid Fayda photo' });
  }

  try {
    const clean = faceResult.clean;
    const input = {
      selfie: clean(selfie),
      frames: frames.map(f => ({ action: f.action, image: clean(f.image) })),
      faydaPhoto: faydaPhoto ? clean(faydaPhoto) : '',
    };
    const result = await liveness.verify(input);
    const message = livenessMessage(result);
    console.log(`[Liveness] passed=${result.liveness.passed}${result.liveness.failed ? ` (${result.liveness.failed})` : ''}` +
      ` match=${result.match ? `${result.match.similarity}% ${result.match.matched ? 'yes' : 'no'}` : result.matchError}` +
      ` antiSpoof=${result.liveness.antiSpoof ? result.liveness.antiSpoof.score : 'n/a'} (${result.ms} ms)`);
    res.json({
      success: true,
      passed: result.liveness.passed,
      matched: !!(result.match && result.match.matched),
      similarity: result.match ? result.match.similarity : null,
      antiSpoofScore: result.liveness.antiSpoof ? result.liveness.antiSpoof.score : null,
      failed: result.liveness.failed || null,
      message,
      token: faceResult.sign({ ...input, result }),
    });
  } catch (error) {
    console.error('[Liveness] Check failed:', error.message);
    res.status(503).json({
      success: false,
      message: error.busy ? 'Many people are verifying right now. Please try again in a minute.' : 'The face check is not available right now. Please try again.',
    });
  }
});

router.post('/upload-video', async (req, res) => {
  try {
    const { video, selfiePhoto, videoMimeType, videoSizeBytes } = req.body;

    if (!video || !selfiePhoto) {
      return res.status(400).json({
        success: false,
        message: 'Both video and selfiePhoto are required (base64 encoded)',
      });
    }

    // Generate unique ID for this verification
    const videoId = `face_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const uploadsDir = path.join(__dirname, '..', 'uploads', 'face-videos');

    // Ensure directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Determine file extension from MIME type
    const ext = videoMimeType?.includes('mp4') ? 'mp4' : 'webm';

    // Save video file
    const videoBuffer = Buffer.from(video, 'base64');
    const videoPath = path.join(uploadsDir, `${videoId}.${ext}`);
    fs.writeFileSync(videoPath, videoBuffer);

    // Save selfie photo
    const selfieBuffer = Buffer.from(selfiePhoto, 'base64');
    const selfiePath = path.join(uploadsDir, `${videoId}_selfie.jpg`);
    fs.writeFileSync(selfiePath, selfieBuffer);

    // Save metadata JSON
    const metadata = {
      videoId,
      videoFile: `${videoId}.${ext}`,
      selfieFile: `${videoId}_selfie.jpg`,
      videoMimeType: videoMimeType || 'video/webm',
      videoSizeBytes: videoSizeBytes || videoBuffer.length,
      selfieSizeBytes: selfieBuffer.length,
      uploadedAt: new Date().toISOString(),
      status: 'pending_review', // KYC team will update this
    };
    fs.writeFileSync(
      path.join(uploadsDir, `${videoId}_meta.json`),
      JSON.stringify(metadata, null, 2)
    );

    console.log(`Face video uploaded: ${videoId} (video: ${(videoBuffer.length / 1024).toFixed(0)} KB, selfie: ${(selfieBuffer.length / 1024).toFixed(0)} KB)`);

    res.json({
      success: true,
      videoId,
      message: 'Face video uploaded successfully for KYC review',
    });

  } catch (error) {
    console.error('Face video upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload face video',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * GET /api/face/video/:videoId
 * Serve a recorded face verification video for KYC review
 * Used by the Customer Onboarding dashboard video player
 */
router.get('/video/:videoId', (req, res) => {
  try {
    const { videoId } = req.params;

    // Sanitize videoId to prevent path traversal
    if (!videoId || /[^a-zA-Z0-9_\-]/.test(videoId)) {
      return res.status(400).json({ success: false, message: 'Invalid video ID' });
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads', 'face-videos');

    // Try .webm first, then .mp4
    let videoPath = path.join(uploadsDir, `${videoId}.webm`);
    let mimeType = 'video/webm';

    if (!fs.existsSync(videoPath)) {
      videoPath = path.join(uploadsDir, `${videoId}.mp4`);
      mimeType = 'video/mp4';
    }

    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;

    // Support range requests for video seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;

      const file = fs.createReadStream(videoPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
      });
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    console.error('Video serve error:', error);
    res.status(500).json({ success: false, message: 'Failed to serve video' });
  }
});

/**
 * GET /api/face/status
 * Check if face-api.js service is ready
 */
router.get('/status', async (req, res) => {
  try {
    await faceApi.loadModels();
    res.json({
      success: true,
      status: 'ready',
      message: 'Face API service is ready',
      threshold: faceApi.FACE_MATCH_THRESHOLD,
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'not_ready',
      message: 'Face API models not loaded: ' + error.message,
    });
  }
});

module.exports = router;
