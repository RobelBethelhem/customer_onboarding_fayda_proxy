# Face-API.js Integration Setup Guide

This guide explains how to set up the free face-api.js face recognition system for the Zemen Bank app.

## Overview

The system uses:
- **On-device (Flutter)**: ML Kit for liveness detection (blink, turn, smile)
- **Backend (Node.js)**: face-api.js for face comparison (selfie vs ID photo)

**No AWS/Azure/Google Cloud costs!** Face-api.js is completely free and open source.

---

## Step 1: Install Backend Dependencies

Open terminal in `D:\fayda\backend` and run:

```bash
# Option 1: Run the setup script (Windows)
setup-face-api.bat

# Option 2: Manual installation
npm install @vladmandic/face-api canvas
```

### Note on `canvas` package

The `canvas` package requires native build tools. If you get errors:

**Windows:**
```bash
npm install --global windows-build-tools
npm install canvas
```

**Or install pre-built binaries:**
```bash
npm install @aspect-build/canvas
```

---

## Step 2: Copy Model Files

Copy the face-api.js models from Smart_Branch to the backend:

```bash
# Create models directory
mkdir models

# Copy from Smart_Branch (run from D:\fayda\backend)
copy D:\Smart_Branch\public\models\ssd_mobilenetv1_model* models\
copy D:\Smart_Branch\public\models\face_landmark_68_model* models\
copy D:\Smart_Branch\public\models\face_recognition_model* models\
copy D:\Smart_Branch\public\models\face_expression_model* models\
```

**Required model files in `models/` folder:**
```
models/
├── ssd_mobilenetv1_model-shard1
├── ssd_mobilenetv1_model-shard2
├── ssd_mobilenetv1_model-weights_manifest.json
├── face_landmark_68_model-shard1
├── face_landmark_68_model-weights_manifest.json
├── face_recognition_model-shard1
├── face_recognition_model-shard2
├── face_recognition_model-weights_manifest.json
├── face_expression_model-shard1
└── face_expression_model-weights_manifest.json
```

---

## Step 3: Start the Backend Server

```bash
cd D:\fayda\backend
npm run dev
```

You should see:
```
Server running on http://0.0.0.0:5000
Loading face-api.js models from: D:\fayda\backend\models
  - ssdMobilenetv1 loaded
  - faceLandmark68Net loaded
  - faceRecognitionNet loaded
  - faceExpressionNet loaded
All face-api.js models loaded successfully!
```

---

## Step 4: Test the Face API

### Check Status
```bash
curl http://localhost:5000/api/face/status
```

Expected response:
```json
{
  "success": true,
  "status": "ready",
  "message": "Face API service is ready",
  "threshold": 0.45
}
```

### Test Face Comparison (PowerShell)
```powershell
# Test with sample base64 images
$body = @{
    selfieImage = "<base64-selfie>"
    idPhoto = "<base64-id-photo>"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:5000/api/face/compare" -Method Post -Body $body -ContentType "application/json"
```

---

## API Endpoints

### POST /api/face/detect
Detect faces in an image.

```json
Request:
{
  "image": "<base64-encoded-image>"
}

Response:
{
  "success": true,
  "faceDetected": true,
  "faceCount": 1,
  "confidence": 0.98,
  "expressions": {
    "happy": 0.8,
    "neutral": 0.15,
    ...
  }
}
```

### POST /api/face/compare
Compare two faces (selfie vs ID photo).

```json
Request:
{
  "selfieImage": "<base64-selfie>",
  "idPhoto": "<base64-id-photo>"
}

Response:
{
  "success": true,
  "matched": true,
  "distance": 0.32,
  "similarity": 68.5,
  "threshold": 0.45,
  "message": "Face verified successfully (68.5% match)"
}
```

### POST /api/face/liveness
Check a liveness challenge.

```json
Request:
{
  "image": "<base64-image>",
  "challenge": "smile"  // smile, blink, turnLeft, turnRight, open_mouth
}

Response:
{
  "success": true,
  "passed": true,
  "confidence": 0.85,
  "challenge": "smile"
}
```

### POST /api/face/verify
Full verification (detect + compare).

```json
Request:
{
  "selfieImage": "<base64-selfie>",
  "idPhoto": "<base64-id-photo>"
}

Response:
{
  "success": true,
  "verified": true,
  "similarity": 72.3,
  "message": "Face verified successfully with 72.3% similarity",
  "steps": [...]
}
```

---

## Face Matching Threshold

The default threshold is `0.45` (Euclidean distance):
- **< 0.45** = Faces MATCH (same person)
- **> 0.45** = Faces DO NOT MATCH

For banking, you may want stricter:
- `0.40` = Stricter (fewer false positives)
- `0.35` = Very strict

To change, edit `D:\fayda\backend\services\faceApiService.js`:
```javascript
const FACE_MATCH_THRESHOLD = 0.40; // Stricter for banking
```

---

## How It Works

### Flow Diagram
```
┌──────────────────────────────────────────────────────────────────┐
│                        FLUTTER APP                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Camera captures video stream                                  │
│  2. ML Kit (on-device) performs:                                  │
│     - Face detection                                              │
│     - Liveness checks (blink, turn, smile)                       │
│  3. After liveness passed, capture selfie                        │
│  4. Send selfie + Fayda photo to backend                         │
│                                                                   │
└─────────────────────────┬────────────────────────────────────────┘
                          │
                          ▼ HTTP POST /api/face/compare
┌──────────────────────────────────────────────────────────────────┐
│                      NODE.JS BACKEND                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  face-api.js performs:                                            │
│  1. Detect face in selfie → get 128-dim descriptor               │
│  2. Detect face in ID photo → get 128-dim descriptor             │
│  3. Calculate Euclidean distance between descriptors             │
│  4. If distance < 0.45 → MATCH                                   │
│                                                                   │
└─────────────────────────┬────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                         RESPONSE                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  { matched: true, similarity: 72.5%, message: "Verified!" }      │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Face Descriptor

Face-api.js generates a **128-dimensional vector** (face descriptor) for each face. This is a numerical representation of facial features.

**Comparison:**
- Same person → descriptors are similar → low Euclidean distance (< 0.45)
- Different people → descriptors are different → high distance (> 0.45)

---

## Troubleshooting

### Models not loading
```
Error: Models directory not found
```
**Solution:** Ensure models are copied to `D:\fayda\backend\models\`

### Canvas installation fails
```
Error: node-gyp rebuild failed
```
**Solution:**
1. Install Windows Build Tools: `npm install -g windows-build-tools`
2. Or use alternative: `npm install @aspect-build/canvas`

### Face not detected
```
{ "faceDetected": false }
```
**Possible causes:**
- Image too dark/bright
- Face too small (< 25% of image)
- Face at extreme angle
- Image corrupted

### Network timeout from Flutter
```
Request timeout. Please try again.
```
**Solutions:**
1. Check server is running: `curl http://localhost:5000/api/face/status`
2. Check phone and PC on same network
3. Use correct IP in Flutter (Developer Settings)

---

## Performance

| Operation | Average Time |
|-----------|--------------|
| Model loading | 2-3 seconds (once) |
| Face detection | 100-200ms |
| Face comparison | 200-400ms |
| Full verification | 400-700ms |

---

## Security Notes

1. **Never expose the API publicly** without authentication
2. **Rate limiting** is enabled (30 requests/minute per IP)
3. **Images are not stored** - processed in memory only
4. For production, add JWT authentication to face endpoints

---

## Comparison with Cloud Services

| Feature | face-api.js (Free) | AWS Rekognition | Azure Face API |
|---------|-------------------|-----------------|----------------|
| Cost | FREE | $1/1000 images | $1/1000 images |
| Accuracy | ~95% | ~99.9% | ~99% |
| Liveness | Basic | Advanced | Advanced |
| Setup | Easy | Medium | Medium |
| Privacy | Data stays local | Cloud | Cloud |

**face-api.js is recommended for:**
- Development/testing
- Budget-conscious deployments
- Privacy-sensitive applications

**Cloud services recommended for:**
- High-security banking (production)
- Regulatory compliance requirements
- Advanced liveness detection needs
