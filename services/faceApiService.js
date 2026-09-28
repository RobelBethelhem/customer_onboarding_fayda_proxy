/**
 * Face API Service - Using face-api.js for face detection and comparison
 *
 * This service provides:
 * - Face detection
 * - Face comparison (1:1 verification)
 * - Liveness indicators
 *
 * Models required in /models folder:
 * - ssd_mobilenetv1_model (face detection)
 * - face_landmark_68_model (landmarks)
 * - face_recognition_model (128-dim descriptors for comparison)
 * - face_expression_model (emotions for liveness)
 */

// face-api.js for Node.js (uses its own bundled TensorFlow)
const faceapi = require('face-api.js');
const canvas = require('canvas');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Python anti-spoofing service URL
const ANTISPOOF_SERVICE_URL = process.env.ANTISPOOF_URL || 'http://localhost:5002';

// Monkey patch face-api.js for Node.js environment
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Configuration
const MODELS_PATH = path.join(__dirname, '../models');
const FACE_MATCH_THRESHOLD = 0.50; // 50% similarity threshold (distance < 0.5 means similarity >= 50%)

let modelsLoaded = false;

/**
 * Load all face-api.js models
 */
async function loadModels() {
  if (modelsLoaded) {
    return true;
  }

  try {
    console.log('Loading face-api.js models from:', MODELS_PATH);

    // Check if models directory exists
    if (!fs.existsSync(MODELS_PATH)) {
      throw new Error(`Models directory not found: ${MODELS_PATH}`);
    }

    // Load models
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
    console.log('  - ssdMobilenetv1 loaded');

    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
    console.log('  - faceLandmark68Net loaded');

    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
    console.log('  - faceRecognitionNet loaded');

    await faceapi.nets.faceExpressionNet.loadFromDisk(MODELS_PATH);
    console.log('  - faceExpressionNet loaded');

    modelsLoaded = true;
    console.log('All face-api.js models loaded successfully!');
    return true;

  } catch (error) {
    console.error('Error loading face-api.js models:', error.message);
    throw error;
  }
}

/**
 * Convert base64 image to canvas Image object
 */
async function base64ToImage(base64String) {
  // Remove data URL prefix if present
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error('Failed to load image: ' + err));
    img.src = buffer;
  });
}

/**
 * Detect faces in an image
 * @param {string} imageBase64 - Base64 encoded image
 * @returns {Object} Detection result with face details
 */
async function detectFaces(imageBase64) {
  await loadModels();

  try {
    const img = await base64ToImage(imageBase64);

    const detections = await faceapi
      .detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceExpressions();

    if (!detections || detections.length === 0) {
      return {
        success: false,
        faceDetected: false,
        faceCount: 0,
        message: 'No face detected in image',
      };
    }

    if (detections.length > 1) {
      return {
        success: false,
        faceDetected: true,
        faceCount: detections.length,
        message: 'Multiple faces detected. Only one face allowed.',
      };
    }

    const face = detections[0];
    const expressions = face.expressions;

    // Find dominant expression
    const dominantExpression = Object.entries(expressions)
      .sort((a, b) => b[1] - a[1])[0];

    return {
      success: true,
      faceDetected: true,
      faceCount: 1,
      confidence: face.detection.score,
      boundingBox: face.detection.box,
      expressions: {
        happy: expressions.happy,
        neutral: expressions.neutral,
        surprised: expressions.surprised,
        sad: expressions.sad,
        angry: expressions.angry,
        disgusted: expressions.disgusted,
        fearful: expressions.fearful,
      },
      dominantExpression: {
        name: dominantExpression[0],
        confidence: dominantExpression[1],
      },
      landmarks: {
        leftEye: face.landmarks.getLeftEye(),
        rightEye: face.landmarks.getRightEye(),
        nose: face.landmarks.getNose(),
        mouth: face.landmarks.getMouth(),
        jawOutline: face.landmarks.getJawOutline(),
      },
    };

  } catch (error) {
    console.error('Face detection error:', error);
    return {
      success: false,
      faceDetected: false,
      message: 'Error detecting face: ' + error.message,
    };
  }
}

/**
 * Compare two faces and return similarity score
 * @param {string} sourceImageBase64 - First image (captured selfie)
 * @param {string} targetImageBase64 - Second image (ID photo from Fayda)
 * @returns {Object} Comparison result with match status and similarity
 */
async function compareFaces(sourceImageBase64, targetImageBase64) {
  await loadModels();

  try {
    // Load both images
    const sourceImg = await base64ToImage(sourceImageBase64);
    const targetImg = await base64ToImage(targetImageBase64);

    // Detect faces and get descriptors
    const sourceDetection = await faceapi
      .detectSingleFace(sourceImg)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!sourceDetection) {
      return {
        success: false,
        matched: false,
        message: 'No face detected in selfie image',
        error: 'SOURCE_NO_FACE',
      };
    }

    const targetDetection = await faceapi
      .detectSingleFace(targetImg)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!targetDetection) {
      return {
        success: false,
        matched: false,
        message: 'No face detected in ID photo',
        error: 'TARGET_NO_FACE',
      };
    }

    // Calculate Euclidean distance between face descriptors
    const distance = faceapi.euclideanDistance(
      sourceDetection.descriptor,
      targetDetection.descriptor
    );

    // Convert distance to similarity percentage (inverse relationship)
    // Distance 0 = 100% similar, Distance 1 = 0% similar
    const similarity = Math.max(0, Math.min(100, (1 - distance) * 100));

    // Check if match passes threshold
    const matched = distance < FACE_MATCH_THRESHOLD;

    return {
      success: true,
      matched,
      distance: Math.round(distance * 1000) / 1000,
      similarity: Math.round(similarity * 100) / 100,
      threshold: FACE_MATCH_THRESHOLD,
      message: matched
        ? `Face verified successfully (${similarity.toFixed(1)}% match)`
        : `Face verification failed. Similarity ${similarity.toFixed(1)}% is below required ${((1 - FACE_MATCH_THRESHOLD) * 100).toFixed(0)}%`,
      details: {
        sourceConfidence: sourceDetection.detection.score,
        targetConfidence: targetDetection.detection.score,
      },
    };

  } catch (error) {
    console.error('Face comparison error:', error);
    return {
      success: false,
      matched: false,
      message: 'Error comparing faces: ' + error.message,
      error: 'COMPARISON_ERROR',
    };
  }
}

/**
 * Check liveness indicators in a face image
 * @param {string} imageBase64 - Face image
 * @param {string} challenge - Challenge type: 'smile', 'blink', 'turnLeft', 'turnRight'
 * @returns {Object} Liveness check result
 */
async function checkLiveness(imageBase64, challenge) {
  await loadModels();

  try {
    const img = await base64ToImage(imageBase64);

    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceExpressions();

    if (!detection) {
      return {
        success: false,
        passed: false,
        message: 'No face detected',
      };
    }

    let passed = false;
    let confidence = 0;
    let details = {};

    switch (challenge.toLowerCase()) {
      case 'smile':
        confidence = detection.expressions.happy;
        passed = confidence > 0.6;
        details = { happyScore: confidence };
        break;

      case 'blink':
        // Check if eyes are closed (eye aspect ratio)
        // face-api.js 68-point landmarks produce higher EAR values than dlib/ML Kit.
        // Typical open-eye EAR: 0.28-0.38, closed-eye EAR: 0.20-0.27.
        // Threshold 0.26 works for most users with face-api.js.
        const leftEye = detection.landmarks.getLeftEye();
        const rightEye = detection.landmarks.getRightEye();
        const leftEAR = calculateEyeAspectRatio(leftEye);
        const rightEAR = calculateEyeAspectRatio(rightEye);
        const avgEAR = (leftEAR + rightEAR) / 2;
        passed = avgEAR < 0.28; // Relaxed for face-api.js landmark precision
        confidence = passed ? 1 - avgEAR : avgEAR;
        details = { eyeAspectRatio: avgEAR, leftEAR, rightEAR };
        break;

      case 'turnleft':
      case 'turn_left':
        // Check face rotation (left eye should be larger/closer)
        const leftEyeL = detection.landmarks.getLeftEye();
        const rightEyeL = detection.landmarks.getRightEye();
        const leftEyeWidth = getWidth(leftEyeL);
        const rightEyeWidth = getWidth(rightEyeL);
        const ratio = leftEyeWidth / rightEyeWidth;
        passed = ratio > 1.15; // Left eye appears larger when turned left
        confidence = Math.min(1, ratio - 1);
        details = { leftEyeWidth, rightEyeWidth, ratio };
        break;

      case 'turnright':
      case 'turn_right':
        // Check face rotation (right eye should be larger/closer)
        const leftEyeR = detection.landmarks.getLeftEye();
        const rightEyeR = detection.landmarks.getRightEye();
        const leftEyeW = getWidth(leftEyeR);
        const rightEyeW = getWidth(rightEyeR);
        const ratioR = rightEyeW / leftEyeW;
        passed = ratioR > 1.15;
        confidence = Math.min(1, ratioR - 1);
        details = { leftEyeWidth: leftEyeW, rightEyeWidth: rightEyeW, ratio: ratioR };
        break;

      case 'surprised':
      case 'raise_eyebrows':
        confidence = detection.expressions.surprised;
        passed = confidence > 0.3;
        details = { surprisedScore: confidence };
        break;

      case 'open_mouth':
        const mouth = detection.landmarks.getMouth();
        const mouthOpenness = calculateMouthOpenness(mouth);
        passed = mouthOpenness > 15;
        confidence = Math.min(1, mouthOpenness / 20);
        details = { mouthOpenness };
        break;

      default:
        return {
          success: false,
          passed: false,
          message: `Unknown challenge: ${challenge}`,
        };
    }

    return {
      success: true,
      passed,
      confidence: Math.round(confidence * 100) / 100,
      challenge,
      details,
      message: passed
        ? `Liveness check passed: ${challenge}`
        : `Liveness check failed: ${challenge}`,
    };

  } catch (error) {
    console.error('Liveness check error:', error);
    return {
      success: false,
      passed: false,
      message: 'Error checking liveness: ' + error.message,
    };
  }
}

/**
 * Full face verification: liveness + comparison
 * @param {string} selfieBase64 - Captured selfie
 * @param {string} idPhotoBase64 - ID photo from Fayda
 * @param {Object} options - Additional options
 * @returns {Object} Complete verification result
 */
async function verifyFace(selfieBase64, idPhotoBase64, options = {}) {
  await loadModels();

  const result = {
    success: false,
    verified: false,
    steps: [],
  };

  try {
    // Step 1: Detect face in selfie
    const selfieDetection = await detectFaces(selfieBase64);
    result.steps.push({
      step: 'selfie_detection',
      passed: selfieDetection.faceDetected && selfieDetection.faceCount === 1,
      details: selfieDetection,
    });

    if (!selfieDetection.faceDetected || selfieDetection.faceCount !== 1) {
      result.message = selfieDetection.message;
      return result;
    }

    // Step 2: Detect face in ID photo
    const idDetection = await detectFaces(idPhotoBase64);
    result.steps.push({
      step: 'id_photo_detection',
      passed: idDetection.faceDetected && idDetection.faceCount === 1,
      details: idDetection,
    });

    if (!idDetection.faceDetected || idDetection.faceCount !== 1) {
      result.message = 'ID photo: ' + idDetection.message;
      return result;
    }

    // Step 3: Compare faces
    const comparison = await compareFaces(selfieBase64, idPhotoBase64);
    result.steps.push({
      step: 'face_comparison',
      passed: comparison.matched,
      details: comparison,
    });

    if (!comparison.matched) {
      result.message = comparison.message;
      result.similarity = comparison.similarity;
      return result;
    }

    // All steps passed
    result.success = true;
    result.verified = true;
    result.similarity = comparison.similarity;
    result.message = `Face verified successfully with ${comparison.similarity.toFixed(1)}% similarity`;

    return result;

  } catch (error) {
    console.error('Face verification error:', error);
    result.message = 'Verification error: ' + error.message;
    return result;
  }
}

/**
 * Passive Liveness Detection — calls Python anti-spoofing CNN service
 *
 * Delegates to a dedicated Python service running on port 5001 that uses
 * advanced computer vision techniques:
 * - FFT frequency domain analysis (detects screen/print artifacts)
 * - Color space analysis (HSV, YCrCb skin validation)
 * - Laplacian texture analysis (micro-texture richness)
 * - Moiré pattern detection (screen pixel interference)
 * - Specular reflection analysis (screen backlighting detection)
 * - Local Binary Pattern analysis (micro-texture fingerprint)
 * - Multi-frame temporal consistency (motion analysis)
 *
 * @param {string[]} framesBase64 - Array of base64 images (8-12 frames over ~3s)
 * @returns {Object} Liveness result with confidence score
 */
async function checkPassiveLiveness(framesBase64) {
  if (!framesBase64 || framesBase64.length < 3) {
    return {
      success: false,
      isLive: false,
      confidence: 0,
      message: 'At least 3 frames required for liveness analysis',
    };
  }

  try {
    // Send frames directly — they are already compressed JPEG base64 from the frontend
    const payloadStr = JSON.stringify({ frames: framesBase64 });
    const payloadSizeMB = (payloadStr.length / (1024 * 1024)).toFixed(2);
    console.log(`Calling Python anti-spoofing service: ${framesBase64.length} frames, payload ~${payloadSizeMB} MB`);

    const response = await axios.post(`${ANTISPOOF_SERVICE_URL}/analyze`, payloadStr, {
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr),
      },
    });

    const result = response.data;
    console.log(`Anti-spoofing result: isLive=${result.isLive}, confidence=${result.confidence}`);

    return {
      success: result.success !== false,
      isLive: result.isLive || false,
      confidence: result.confidence || 0,
      message: result.message || 'Analysis complete',
      checks: result.checks || {},
    };

  } catch (error) {
    // If Python service is down, log clearly and fail closed (reject)
    if (error.code === 'ECONNREFUSED') {
      console.error('Anti-spoofing service not running! Start it with: python antispoof/antispoof_service.py');
      return {
        success: false,
        isLive: false,
        confidence: 0,
        message: 'Liveness service unavailable. Please try again later.',
      };
    }

    // Detailed error logging
    if (error.response) {
      console.error(`Passive liveness HTTP ${error.response.status}:`);
      console.error(`  Headers:`, JSON.stringify(error.response.headers || {}).substring(0, 200));
      console.error(`  Body:`, JSON.stringify(error.response.data || '').substring(0, 500));
    } else if (error.request) {
      console.error('Passive liveness: No response received');
      console.error(`  Code: ${error.code}`);
      console.error(`  Message: ${error.message}`);
    } else {
      console.error('Passive liveness error:', error.message);
    }

    const errMsg = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data || '').substring(0, 300)}`
      : error.message;
    return {
      success: false,
      isLive: false,
      confidence: 0,
      message: 'Liveness analysis failed: ' + errMsg,
    };
  }
}

// Helper functions
function calculateEyeAspectRatio(eye) {
  // Eye aspect ratio (EAR) for blink detection
  // EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
  const vertical1 = distance(eye[1], eye[5]);
  const vertical2 = distance(eye[2], eye[4]);
  const horizontal = distance(eye[0], eye[3]);
  return (vertical1 + vertical2) / (2 * horizontal);
}

function calculateMouthOpenness(mouth) {
  // Distance between top and bottom lip
  const topLip = mouth[14]; // Top lip center
  const bottomLip = mouth[18]; // Bottom lip center
  return distance(topLip, bottomLip);
}

function distance(point1, point2) {
  return Math.sqrt(
    Math.pow(point2.x - point1.x, 2) + Math.pow(point2.y - point1.y, 2)
  );
}

function getWidth(points) {
  const xs = points.map(p => p.x);
  return Math.max(...xs) - Math.min(...xs);
}

/**
 * Check for face occlusion (mask, hand covering, glasses, etc.)
 * Uses 68-point facial landmarks to detect if key features are visible
 *
 * Landmark indices:
 * - Jaw outline: 0-16
 * - Right eyebrow: 17-21
 * - Left eyebrow: 22-26
 * - Nose bridge: 27-30
 * - Nose bottom: 31-35
 * - Right eye: 36-41
 * - Left eye: 42-47
 * - Outer lip: 48-59
 * - Inner lip: 60-67
 *
 * @param {string} imageBase64 - Base64 encoded image
 * @returns {Object} Occlusion check result
 */
async function checkOcclusion(imageBase64) {
  await loadModels();

  try {
    const img = await base64ToImage(imageBase64);

    // Detect face with landmarks and expressions
    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceExpressions();

    if (!detection) {
      return {
        success: false,
        faceDetected: false,
        isOccluded: true,
        occlusionReason: 'No face detected in image',
        allFeaturesVisible: false,
      };
    }

    const landmarks = detection.landmarks;
    const positions = landmarks.positions;

    // Get facial feature regions
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const nose = landmarks.getNose();
    const mouth = landmarks.getMouth();
    const jawOutline = landmarks.getJawOutline();

    // Calculate face bounding box
    const faceBox = detection.detection.box;
    const faceWidth = faceBox.width;
    const faceHeight = faceBox.height;

    // Analyze each feature for occlusion
    let leftEyeVisible = true;
    let rightEyeVisible = true;
    let noseVisible = true;
    let mouthVisible = true;
    let hasMask = false;
    let occlusionReason = null;

    // ========== EYE CHECKS ==========
    const leftEyeWidth = getWidth(leftEye);
    const leftEyeHeight = getHeight(leftEye);
    const leftEyeAspectRatio = leftEyeHeight / leftEyeWidth;
    const leftEyeArea = leftEyeWidth * leftEyeHeight;

    const rightEyeWidth = getWidth(rightEye);
    const rightEyeHeight = getHeight(rightEye);
    const rightEyeAspectRatio = rightEyeHeight / rightEyeWidth;
    const rightEyeArea = rightEyeWidth * rightEyeHeight;

    // Check eye symmetry - if one eye is much smaller, likely occluded
    const eyeAreaRatio = Math.min(leftEyeArea, rightEyeArea) / Math.max(leftEyeArea, rightEyeArea);

    if (leftEyeWidth < faceWidth * 0.06 || leftEyeAspectRatio < 0.1 || leftEyeAspectRatio > 0.9) {
      leftEyeVisible = false;
      occlusionReason = 'Left eye is not visible';
    }

    if (rightEyeWidth < faceWidth * 0.06 || rightEyeAspectRatio < 0.1 || rightEyeAspectRatio > 0.9) {
      rightEyeVisible = false;
      if (!occlusionReason) occlusionReason = 'Right eye is not visible';
    }

    // If eyes are very asymmetric, one might be covered
    if (eyeAreaRatio < 0.4 && leftEyeVisible && rightEyeVisible) {
      if (leftEyeArea < rightEyeArea) {
        leftEyeVisible = false;
        occlusionReason = 'Left eye appears covered';
      } else {
        rightEyeVisible = false;
        occlusionReason = 'Right eye appears covered';
      }
    }

    // ========== NOSE CHECKS (ENHANCED) ==========
    const noseHeight = getHeight(nose);
    const noseWidth = getWidth(nose);
    const noseAspectRatio = noseHeight / (noseWidth + 0.1);

    // Nose tip should be at expected position
    const noseTipPoint = nose[6] || nose[Math.floor(nose.length / 2)];
    const noseTopPoint = nose[0];
    const noseBottomPoint = nose[nose.length - 1];

    // Check nose proportions
    const noseVerticalSpan = noseBottomPoint.y - noseTopPoint.y;
    const expectedNoseSpan = faceHeight * 0.25; // Nose typically 20-30% of face height

    console.log(`  Nose analysis: height=${noseHeight.toFixed(1)}, width=${noseWidth.toFixed(1)}, ` +
                `AR=${noseAspectRatio.toFixed(2)}, span=${noseVerticalSpan.toFixed(1)}`);

    if (noseHeight < faceHeight * 0.12) {
      noseVisible = false;
      if (!occlusionReason) occlusionReason = 'Nose appears covered';
    } else if (noseWidth < faceWidth * 0.08) {
      noseVisible = false;
      if (!occlusionReason) occlusionReason = 'Nose not fully visible';
    } else if (noseAspectRatio < 1.0 || noseAspectRatio > 4.0) {
      // Abnormal nose shape may indicate partial occlusion
      noseVisible = false;
      if (!occlusionReason) occlusionReason = 'Nose shape abnormal';
    } else if (noseVerticalSpan < expectedNoseSpan * 0.5) {
      // Nose appears compressed - likely covered
      noseVisible = false;
      if (!occlusionReason) occlusionReason = 'Lower nose area covered';
    }

    // ========== MOUTH/LIP CHECKS (CRITICAL FOR HAND DETECTION - BANKING GRADE) ==========
    // Outer lip landmarks: 48-59 (12 points around outer lip)
    // Inner lip landmarks: 60-67 (8 points around inner lip)
    const outerLip = mouth.slice(0, 12);  // Outer lip contour
    const innerLip = mouth.slice(12, 20); // Inner lip contour

    const outerLipWidth = getWidth(outerLip);
    const outerLipHeight = getHeight(outerLip);
    const innerLipWidth = getWidth(innerLip);
    const innerLipHeight = getHeight(innerLip);

    // Calculate lip areas
    const outerLipArea = outerLipWidth * outerLipHeight;
    const innerLipArea = innerLipWidth * innerLipHeight;

    // Use comprehensive lip analysis for banking-grade detection
    const lipAnalysis = analyzeLipGeometry(outerLip, innerLip, faceWidth, faceHeight);
    const lipRegularityScore = lipAnalysis.overallScore;

    // Expected mouth proportions relative to face
    const expectedMouthWidth = faceWidth * 0.40;  // Mouth typically 35-45% of face width
    const expectedMouthHeight = faceHeight * 0.10; // Mouth typically 8-12% of face height

    // Check if mouth dimensions are abnormal
    const mouthWidthRatio = outerLipWidth / expectedMouthWidth;
    const mouthHeightRatio = outerLipHeight / expectedMouthHeight;

    // Detailed logging for debugging
    console.log(`  Lip analysis: outerW=${outerLipWidth.toFixed(1)}, outerH=${outerLipHeight.toFixed(1)}, ` +
                `innerW=${innerLipWidth.toFixed(1)}, innerH=${innerLipHeight.toFixed(1)}`);
    console.log(`  Lip scores: regularity=${lipRegularityScore.toFixed(2)}, valid=${lipAnalysis.isValid}, ` +
                `widthRatio=${mouthWidthRatio.toFixed(2)}, heightRatio=${mouthHeightRatio.toFixed(2)}`);
    console.log(`  Lip details: uniformity=${(lipAnalysis.scores.uniformity || 0).toFixed(2)}, ` +
                `symmetry=${(lipAnalysis.scores.symmetry || 0).toFixed(2)}, ` +
                `aspectRatio=${(lipAnalysis.scores.aspectRatio || 0).toFixed(2)}`);
    if (lipAnalysis.reasons.length > 0) {
      console.log(`  Lip issues: ${lipAnalysis.reasons.join(', ')}`);
    }

    // ========== ULTRA-STRICT HAND/OCCLUSION DETECTION (BANKING-GRADE) ==========
    // Key insight: face-api.js places landmarks even on hands - we must detect anomalies
    // in spatial relationships, proportions, and cross-feature validation

    const noseBottom = nose[nose.length - 1];
    const noseTip = nose[6] || nose[4];
    const mouthTop = outerLip[3];
    const mouthBottom = outerLip[9];
    const mouthLeft = outerLip[0];
    const mouthRight = outerLip[6];
    const mouthCenter = {
      x: (mouthLeft.x + mouthRight.x) / 2,
      y: (mouthTop.y + mouthBottom.y) / 2
    };

    // Key distances
    const noseMouthGap = mouthTop.y - noseBottom.y;
    const mouthToJawBottom = jawOutline[8].y - mouthBottom.y;
    const noseToJaw = jawOutline[8].y - noseBottom.y;
    const eyeToNose = nose[0].y - ((leftEye[0].y + rightEye[0].y) / 2);
    const eyeToMouth = mouthCenter.y - ((leftEye[0].y + rightEye[0].y) / 2);

    // Jaw analysis
    const jawBottomPoints = jawOutline.slice(5, 12);
    let jawIrregularity = 0;
    for (let i = 1; i < jawBottomPoints.length - 1; i++) {
      const prev = jawBottomPoints[i - 1];
      const curr = jawBottomPoints[i];
      const next = jawBottomPoints[i + 1];
      const angle1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      const angle2 = Math.atan2(next.y - curr.y, next.x - curr.x);
      jawIrregularity += Math.abs(angle1 - angle2);
    }
    const avgJawIrregularity = jawIrregularity / (jawBottomPoints.length - 2);

    // Mouth vertical position ratio
    const mouthVerticalRatio = noseToJaw > 0 ? (mouthCenter.y - noseBottom.y) / noseToJaw : 0;

    // Nose center for alignment
    const noseCenter = (nose[0].x + nose[nose.length - 1].x) / 2;
    const mouthHorizontalOffset = Math.abs(mouthCenter.x - noseCenter) / faceWidth;

    // Eye center for cross-validation
    const eyeCenter = {
      x: (leftEye[0].x + rightEye[3].x) / 2,
      y: (leftEye[0].y + rightEye[0].y) / 2
    };

    let mouthOcclusionReasons = [];
    let criticalFailures = [];

    // ===== STRICT HAND/OCCLUSION DETECTION FOR BANKING =====
    // When hand covers mouth, landmarks are placed on the hand surface
    // This creates specific detectable anomalies in geometry

    const noseMouthGapRatio = noseMouthGap / faceHeight;
    const mouthToJawRatio = mouthToJawBottom / faceHeight;

    // Calculate additional metrics for hand detection
    const lipAspectRatio = outerLipWidth / (outerLipHeight + 0.1);
    const innerOuterRatio = innerLipArea / (outerLipArea + 0.1);

    // Check lip corner angles - real lips have curved corners
    const leftCorner = outerLip[0];
    const rightCorner = outerLip[6];
    const topCenter = outerLip[3];
    const bottomCenter = outerLip[9];

    // Calculate if corners are at expected height (between top and bottom center)
    const cornerHeightRatio = (leftCorner.y + rightCorner.y) / 2;
    const midHeight = (topCenter.y + bottomCenter.y) / 2;
    const cornerDeviation = Math.abs(cornerHeightRatio - midHeight) / (outerLipHeight + 0.1);

    console.log(`  Key metrics: noseMouthGap=${noseMouthGap.toFixed(1)}px (${(noseMouthGapRatio * 100).toFixed(1)}%), ` +
                `mouthToJaw=${mouthToJawBottom.toFixed(1)}px (${(mouthToJawRatio * 100).toFixed(1)}%)`);
    console.log(`  Lip metrics: width=${outerLipWidth.toFixed(1)}, height=${outerLipHeight.toFixed(1)}, ` +
                `AR=${lipAspectRatio.toFixed(2)}, regularity=${lipRegularityScore.toFixed(2)}`);
    console.log(`  Advanced: uniformity=${(lipAnalysis.scores.uniformity || 0).toFixed(2)}, ` +
                `symmetry=${(lipAnalysis.scores.symmetry || 0).toFixed(2)}, innerOuter=${innerOuterRatio.toFixed(2)}`);

    // ===== CRITICAL CHECKS (any one = instant fail) =====

    // CHECK 1: Mouth must be below nose
    if (noseMouthGap <= 0) {
      criticalFailures.push('Mouth above nose');
    }

    // CHECK 2: Minimum nose-mouth gap
    if (noseMouthGap < 8) {
      criticalFailures.push('Nose-mouth gap too small');
    }

    // CHECK 3: Lip width sanity check
    if (outerLipWidth < 30) {
      criticalFailures.push('Lip width too narrow');
    }

    // CHECK 4: Lip height sanity check
    if (outerLipHeight < 10) {
      criticalFailures.push('Lip height too small');
    }

    // ===== GEOMETRY CHECKS (stricter thresholds) =====

    // CHECK 5: Lip regularity - hand surface is irregular
    if (lipRegularityScore < 0.70) {
      mouthOcclusionReasons.push('Lip shape irregular');
    }

    // CHECK 6: Point distribution - hand causes clustered points
    if (lipAnalysis.scores.uniformity !== undefined && lipAnalysis.scores.uniformity < 0.65) {
      mouthOcclusionReasons.push('Point clustering detected');
    }

    // CHECK 7: Lip symmetry - hand creates asymmetry
    if (lipAnalysis.scores.symmetry !== undefined && lipAnalysis.scores.symmetry < 0.75) {
      mouthOcclusionReasons.push('Asymmetric lip shape');
    }

    // CHECK 8: Lip aspect ratio - real lips have wide range (1.5 to 7.0)
    // Note: Normal human lips can have AR from 1.5 (tall lips) to 6+ (thin lips)
    if (lipAspectRatio < 1.2 || lipAspectRatio > 8.0) {
      mouthOcclusionReasons.push('Abnormal lip proportions');
    }

    // CHECK 9: Inner/outer lip ratio - hand obscures inner lip
    if (innerOuterRatio < 0.15 || innerOuterRatio > 0.7) {
      mouthOcclusionReasons.push('Inner lip not visible');
    }

    // CHECK 10: Jaw irregularity - hand disrupts jaw contour
    if (avgJawIrregularity > 0.30) {
      mouthOcclusionReasons.push('Jaw contour disrupted');
    }

    // CHECK 11: Mouth vertical position
    if (mouthVerticalRatio < 0.25 || mouthVerticalRatio > 0.65) {
      mouthOcclusionReasons.push('Mouth position abnormal');
    }

    // CHECK 12: Corner position deviation
    if (cornerDeviation > 0.5) {
      mouthOcclusionReasons.push('Lip corners misaligned');
    }

    // CHECK 13: Mouth-to-jaw ratio (hand between mouth and chin)
    if (mouthToJawRatio < 0.08) {
      mouthOcclusionReasons.push('Chin area obscured');
    }

    // DECISION:
    // - Any critical failure = occluded (geometry sanity)
    // - 2+ regular issues = occluded (avoid false positives)
    if (criticalFailures.length > 0) {
      mouthVisible = false;
      occlusionReason = criticalFailures[0];
    } else if (mouthOcclusionReasons.length >= 2) {
      mouthVisible = false;
      occlusionReason = mouthOcclusionReasons.slice(0, 2).join(', ');
    }

    console.log(`  Result: critical=${criticalFailures.length}, issues=${mouthOcclusionReasons.length}, visible=${mouthVisible}`);
    if (!mouthVisible) {
      console.log(`  Reason: ${occlusionReason}`);
    }
    if (criticalFailures.length > 0) {
      console.log(`  Critical failures: [${criticalFailures.join(', ')}]`);
    }
    if (mouthOcclusionReasons.length > 0) {
      console.log(`  Other issues: [${mouthOcclusionReasons.join(', ')}]`);
    }

    // ========== MASK DETECTION ==========
    // Check for mask: nose visible but mouth area abnormally compressed
    if (noseVisible && noseMouthGapRatio < 0.04 && outerLipHeight < faceHeight * 0.05) {
      hasMask = true;
      mouthVisible = false;
      occlusionReason = 'Please remove your mask';
    }

    // Check lower face compression (mask signature)
    const lowerFaceHeight = jawOutline[8].y - nose[0].y;
    const upperFaceHeight = nose[0].y - faceBox.y;

    if (lowerFaceHeight < upperFaceHeight * 0.5 && outerLipHeight < faceHeight * 0.05) {
      hasMask = true;
      mouthVisible = false;
      occlusionReason = 'Please remove your mask';
    }

    // ========== FINAL CHECKS ==========
    if (!leftEyeVisible && !rightEyeVisible) {
      occlusionReason = 'Eyes are not visible - remove any obstruction';
    }

    // Calculate visibility score
    const featuresChecked = 4;
    const featuresVisible = (leftEyeVisible ? 1 : 0) + (rightEyeVisible ? 1 : 0) +
                           (noseVisible ? 1 : 0) + (mouthVisible ? 1 : 0);
    const visibilityScore = (featuresVisible / featuresChecked) * 100;

    const isOccluded = !leftEyeVisible || !rightEyeVisible || !noseVisible || !mouthVisible || hasMask;

    // Detailed logging
    console.log('Occlusion check results:');
    console.log(`  - Left eye: ${leftEyeVisible ? 'visible' : 'OCCLUDED'} (width: ${leftEyeWidth.toFixed(1)}, AR: ${leftEyeAspectRatio.toFixed(2)}, area: ${leftEyeArea.toFixed(0)})`);
    console.log(`  - Right eye: ${rightEyeVisible ? 'visible' : 'OCCLUDED'} (width: ${rightEyeWidth.toFixed(1)}, AR: ${rightEyeAspectRatio.toFixed(2)}, area: ${rightEyeArea.toFixed(0)})`);
    console.log(`  - Eye symmetry: ${(eyeAreaRatio * 100).toFixed(0)}%`);
    console.log(`  - Nose: ${noseVisible ? 'visible' : 'OCCLUDED'} (height: ${noseHeight.toFixed(1)}, width: ${noseWidth.toFixed(1)})`);
    console.log(`  - Mouth: ${mouthVisible ? 'visible' : 'OCCLUDED'} (outer: ${outerLipWidth.toFixed(1)}x${outerLipHeight.toFixed(1)}, regularity: ${lipRegularityScore.toFixed(2)})`);
    console.log(`  - Mask detected: ${hasMask}`);
    console.log(`  - Overall: ${isOccluded ? 'OCCLUDED' : 'CLEAR'} - ${occlusionReason || 'All features visible'}`);

    return {
      success: true,
      faceDetected: true,
      isOccluded,
      hasMask,
      leftEyeVisible,
      rightEyeVisible,
      noseVisible,
      mouthVisible,
      allFeaturesVisible: leftEyeVisible && rightEyeVisible && noseVisible && mouthVisible,
      visibilityScore,
      occlusionReason: isOccluded ? occlusionReason : null,
      faceConfidence: detection.detection.score,
      lipRegularityScore,
      details: {
        leftEye: { width: leftEyeWidth, height: leftEyeHeight, aspectRatio: leftEyeAspectRatio, area: leftEyeArea },
        rightEye: { width: rightEyeWidth, height: rightEyeHeight, aspectRatio: rightEyeAspectRatio, area: rightEyeArea },
        eyeSymmetry: eyeAreaRatio,
        nose: { width: noseWidth, height: noseHeight },
        mouth: {
          outerWidth: outerLipWidth, outerHeight: outerLipHeight, outerArea: outerLipArea,
          innerWidth: innerLipWidth, innerHeight: innerLipHeight, innerArea: innerLipArea,
          regularityScore: lipRegularityScore,
        },
        faceBox: { width: faceWidth, height: faceHeight },
        noseMouthGap,
      },
    };

  } catch (error) {
    console.error('Occlusion check error:', error);
    return {
      success: false,
      faceDetected: false,
      isOccluded: true,
      occlusionReason: 'Error checking occlusion: ' + error.message,
      allFeaturesVisible: false,
    };
  }
}

/**
 * Comprehensive lip analysis for banking-grade occlusion detection
 * Returns detailed analysis object with multiple metrics
 */
function analyzeLipGeometry(outerLip, innerLip, faceWidth, faceHeight) {
  const result = {
    isValid: true,
    scores: {},
    reasons: [],
    overallScore: 1.0
  };

  try {
    // ===== 1. BASIC DIMENSIONS =====
    const outerWidth = getWidth(outerLip);
    const outerHeight = getHeight(outerLip);
    const innerWidth = innerLip.length > 0 ? getWidth(innerLip) : 0;
    const innerHeight = innerLip.length > 0 ? getHeight(innerLip) : 0;

    // Expected proportions for real lips
    const expectedWidth = faceWidth * 0.40;  // Lips typically 35-45% of face width
    const expectedHeight = faceHeight * 0.08; // Lips typically 6-10% of face height

    const widthRatio = outerWidth / expectedWidth;
    const heightRatio = outerHeight / expectedHeight;

    result.scores.widthRatio = widthRatio;
    result.scores.heightRatio = heightRatio;

    // Stricter width check for banking
    if (widthRatio < 0.6) {
      result.reasons.push(`Mouth too narrow (${(widthRatio * 100).toFixed(0)}% of expected)`);
      result.isValid = false;
    }

    // ===== 2. LIP SHAPE ANALYSIS (Cupid's Bow Detection) =====
    // Upper lip points: indices 0, 1, 2, 3, 4, 5, 6 in outer lip (left to right)
    // The cupid's bow creates a dip at indices 2, 3, 4 (center of upper lip)
    if (outerLip.length >= 7) {
      const upperLipLeft = outerLip[0];
      const upperLipCenter = outerLip[3]; // Center top
      const upperLipRight = outerLip[6];

      // Cupid's bow: center should be slightly higher (lower Y) than corners
      const leftToCenter = upperLipLeft.y - upperLipCenter.y;
      const rightToCenter = upperLipRight.y - upperLipCenter.y;
      const cupidBowDepth = (leftToCenter + rightToCenter) / 2;

      // Real lips have cupid's bow with depth of 2-15% of lip height
      const cupidBowRatio = cupidBowDepth / (outerHeight + 0.1);
      result.scores.cupidBow = cupidBowRatio;

      // When hand covers, the "bow" may be inverted or flat
      if (cupidBowRatio < -0.1 || cupidBowRatio > 0.5) {
        result.reasons.push('Upper lip shape abnormal');
      }
    }

    // ===== 3. LOWER LIP CURVATURE =====
    // Lower lip points: indices 6, 7, 8, 9, 10, 11, 0 (wrapping around)
    if (outerLip.length >= 12) {
      const lowerLipLeft = outerLip[6];
      const lowerLipBottom = outerLip[9]; // Bottom center
      const lowerLipRight = outerLip[0]; // Wraps back to start

      // Lower lip should curve down (higher Y at center)
      const lowerCurve = lowerLipBottom.y - ((lowerLipLeft.y + lowerLipRight.y) / 2);
      const lowerCurveRatio = lowerCurve / (outerHeight + 0.1);
      result.scores.lowerCurve = lowerCurveRatio;

      // Real lower lip curves down (positive ratio between 0.1 and 0.8)
      if (lowerCurveRatio < 0.05 || lowerCurveRatio > 1.0) {
        result.reasons.push('Lower lip curvature abnormal');
      }
    }

    // ===== 4. INNER/OUTER LIP SEPARATION =====
    // Inner lip should be contained within outer lip with consistent margins
    if (innerLip.length >= 4 && outerLip.length >= 12) {
      const innerCenterTop = innerLip[2] || innerLip[1];
      const innerCenterBottom = innerLip[6] || innerLip[5];
      const outerCenterTop = outerLip[3];
      const outerCenterBottom = outerLip[9];

      const topMargin = innerCenterTop.y - outerCenterTop.y;
      const bottomMargin = outerCenterBottom.y - innerCenterBottom.y;

      result.scores.topMargin = topMargin;
      result.scores.bottomMargin = bottomMargin;

      // Margins should be positive and reasonable
      if (topMargin < 0 || bottomMargin < 0) {
        result.reasons.push('Inner lip outside outer lip bounds');
        result.isValid = false;
      }
    }

    // ===== 5. HORIZONTAL SYMMETRY =====
    // Real lips are relatively symmetric left-to-right
    if (outerLip.length >= 12) {
      const centerX = (outerLip[0].x + outerLip[6].x) / 2;

      let leftPoints = outerLip.filter(p => p.x < centerX);
      let rightPoints = outerLip.filter(p => p.x >= centerX);

      // Calculate average Y for each side
      const leftAvgY = leftPoints.reduce((sum, p) => sum + p.y, 0) / (leftPoints.length || 1);
      const rightAvgY = rightPoints.reduce((sum, p) => sum + p.y, 0) / (rightPoints.length || 1);

      const symmetryDiff = Math.abs(leftAvgY - rightAvgY);
      const symmetryRatio = symmetryDiff / (outerHeight + 0.1);
      result.scores.symmetry = 1 - Math.min(symmetryRatio, 1);

      // Asymmetry > 30% is suspicious
      if (symmetryRatio > 0.3) {
        result.reasons.push('Lip asymmetry detected');
      }
    }

    // ===== 6. POINT DISTRIBUTION UNIFORMITY =====
    // Real lip landmarks should be evenly spaced along the contour
    if (outerLip.length >= 6) {
      const distances = [];
      for (let i = 0; i < outerLip.length; i++) {
        const next = (i + 1) % outerLip.length;
        distances.push(distance(outerLip[i], outerLip[next]));
      }

      const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
      const distVariance = distances.reduce((sum, d) => sum + Math.pow(d - avgDist, 2), 0) / distances.length;
      const distStdDev = Math.sqrt(distVariance);
      const uniformityScore = 1 - Math.min(distStdDev / (avgDist + 0.1), 1);

      result.scores.uniformity = uniformityScore;

      // When hand covers, points may cluster (low uniformity)
      if (uniformityScore < 0.4) {
        result.reasons.push('Lip point distribution irregular');
        result.isValid = false;
      }
    }

    // ===== 7. ASPECT RATIO CHECK =====
    const aspectRatio = outerWidth / (outerHeight + 0.1);
    result.scores.aspectRatio = aspectRatio;

    // Real lips have aspect ratio between 2.5 and 6.0
    if (aspectRatio < 2.0 || aspectRatio > 7.0) {
      result.reasons.push(`Lip aspect ratio abnormal (${aspectRatio.toFixed(1)})`);
    }

    // ===== 8. MINIMUM ABSOLUTE SIZE =====
    // For banking, require minimum lip size regardless of face size
    if (outerWidth < 25 || outerHeight < 8) {
      result.reasons.push('Lips too small to verify');
      result.isValid = false;
    }

    // ===== CALCULATE OVERALL SCORE =====
    let scoreSum = 0;
    let scoreCount = 0;

    // Width/height ratios (weight: 25%)
    scoreSum += Math.min(widthRatio, 1.2) / 1.2 * 0.25;
    scoreCount += 0.25;

    // Uniformity (weight: 30%)
    if (result.scores.uniformity !== undefined) {
      scoreSum += result.scores.uniformity * 0.30;
      scoreCount += 0.30;
    }

    // Symmetry (weight: 20%)
    if (result.scores.symmetry !== undefined) {
      scoreSum += result.scores.symmetry * 0.20;
      scoreCount += 0.20;
    }

    // Shape checks (weight: 25%)
    let shapeScore = 1.0;
    if (result.reasons.length > 0) {
      shapeScore = Math.max(0, 1 - (result.reasons.length * 0.25));
    }
    scoreSum += shapeScore * 0.25;
    scoreCount += 0.25;

    result.overallScore = scoreCount > 0 ? scoreSum / scoreCount : 0.5;

    // If multiple issues found, mark as invalid
    if (result.reasons.length >= 2) {
      result.isValid = false;
    }

    return result;

  } catch (e) {
    console.error('Lip analysis error:', e);
    return {
      isValid: false,
      scores: {},
      reasons: ['Analysis error'],
      overallScore: 0.3
    };
  }
}

/**
 * Legacy wrapper for compatibility
 */
function calculateLipRegularity(outerLip, innerLip, faceWidth, faceHeight) {
  const analysis = analyzeLipGeometry(outerLip, innerLip, faceWidth, faceHeight);
  return analysis.overallScore;
}

// Helper function to get height of landmark region
function getHeight(points) {
  const ys = points.map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

module.exports = {
  loadModels,
  detectFaces,
  compareFaces,
  checkLiveness,
  checkPassiveLiveness,
  verifyFace,
  checkOcclusion,
  FACE_MATCH_THRESHOLD,
};
