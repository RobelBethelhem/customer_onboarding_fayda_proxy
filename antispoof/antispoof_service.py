"""
Anti-Spoofing Liveness Detection Service

A lightweight HTTP micro-service that analyzes face images to detect presentation
attacks (printed photos, screen replays, masks).

Uses Python's built-in http.server — NO Flask, NO Werkzeug.

Runs on port 5001 and is called by the Node.js backend.
"""

# Force unbuffered output
import sys
import os
os.environ['PYTHONUNBUFFERED'] = '1'

import json
import base64
import traceback
import numpy as np
import cv2
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO

print("[BOOT] All imports OK", flush=True)


# =============================================================================
# Helpers
# =============================================================================
def to_python(obj):
    """Recursively convert numpy types to native Python for JSON serialization."""
    if isinstance(obj, dict):
        return {k: to_python(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [to_python(v) for v in obj]
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        v = float(obj)
        return 0.0 if (v != v or v == float('inf') or v == float('-inf')) else v  # NaN/Inf guard
    elif isinstance(obj, float):
        return 0.0 if (obj != obj or obj == float('inf') or obj == float('-inf')) else obj
    elif isinstance(obj, np.ndarray):
        return to_python(obj.tolist())
    elif isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def decode_base64_image(b64_string):
    """Decode base64 string to OpenCV image (BGR)."""
    if b64_string.startswith('data:image'):
        b64_string = b64_string.split(',', 1)[1]
    img_bytes = base64.b64decode(b64_string)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return img


def detect_face_region(img):
    """Detect face region using Haar cascade."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    return tuple(faces[0])


def crop_face(img, face_rect, margin=0.3):
    x, y, w, h = face_rect
    H, W = img.shape[:2]
    mx, my = int(w * margin), int(h * margin)
    return img[max(0, y-my):min(H, y+h+my), max(0, x-mx):min(W, x+w+mx)]


def safe_float(v):
    """Ensure a value is a finite float."""
    f = float(v)
    return 0.0 if (f != f or f == float('inf') or f == float('-inf')) else f


# =============================================================================
# CHECK 1: Frequency Domain Analysis (FFT)
# =============================================================================
def analyze_frequency(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (128, 128))
    f = np.fft.fft2(gray.astype(np.float32))
    fshift = np.fft.fftshift(f)
    magnitude = np.log1p(np.abs(fshift))
    h, w = magnitude.shape
    cy, cx = h // 2, w // 2
    low_r = int(min(h, w) * 0.1)
    mid_r = int(min(h, w) * 0.25)
    y, x = np.ogrid[:h, :w]
    dist = np.sqrt((x - cx)**2 + (y - cy)**2)
    low_energy = safe_float(np.mean(magnitude[dist <= low_r]))
    mid_energy = safe_float(np.mean(magnitude[(dist > low_r) & (dist <= mid_r)]))
    high_energy = safe_float(np.mean(magnitude[dist > mid_r]))
    total = low_energy + mid_energy + high_energy + 1e-10
    high_ratio = high_energy / total
    score = min(1.0, max(0.0, (high_ratio - 0.15) / 0.15))
    return score, {'high_ratio': high_ratio, 'high_energy': high_energy}


# =============================================================================
# CHECK 2: Color Space Analysis
# =============================================================================
def analyze_color_distribution(face_img):
    face_resized = cv2.resize(face_img, (128, 128))
    ycrcb = cv2.cvtColor(face_resized, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[:, :, 1].astype(np.float32)
    cb = ycrcb[:, :, 2].astype(np.float32)
    skin_mask = (cr >= 133) & (cr <= 173) & (cb >= 77) & (cb <= 127)
    skin_ratio = safe_float(np.mean(skin_mask))
    cr_std = safe_float(np.std(cr[skin_mask])) if np.sum(skin_mask) > 100 else 0.0
    hsv = cv2.cvtColor(face_resized, cv2.COLOR_BGR2HSV)
    val_std = safe_float(np.std(hsv[:, :, 2].astype(np.float32)))
    sat_hist = cv2.calcHist([hsv], [1], None, [32], [0, 256]).flatten()
    sat_hist = sat_hist / (sat_hist.sum() + 1e-10)
    sat_entropy = safe_float(-np.sum(sat_hist * np.log2(sat_hist + 1e-10)))
    score = 0.0
    if 0.15 < skin_ratio < 0.85: score += 0.25
    if cr_std > 4.0: score += 0.25
    elif cr_std > 2.5: score += 0.15
    if sat_entropy > 3.5: score += 0.25
    elif sat_entropy > 2.8: score += 0.15
    if val_std > 30: score += 0.25
    elif val_std > 20: score += 0.15
    return score, {'skin_ratio': skin_ratio, 'cr_std': cr_std, 'sat_entropy': sat_entropy, 'val_std': val_std}


# =============================================================================
# CHECK 3: Texture Analysis
# =============================================================================
def analyze_texture(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (256, 256))
    lap_var = safe_float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobely = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    grad_mag = np.sqrt(sobelx**2 + sobely**2)
    grad_std = safe_float(np.std(grad_mag))
    grad_dir = np.arctan2(sobely, sobelx + 1e-10)
    mask = grad_mag > np.mean(grad_mag)
    dir_std = safe_float(np.std(grad_dir[mask])) if np.any(mask) else 0.0
    score = 0.0
    if lap_var > 200: score += 0.35
    elif lap_var > 80: score += 0.20
    elif lap_var > 40: score += 0.10
    if grad_std > 25: score += 0.35
    elif grad_std > 15: score += 0.20
    elif grad_std > 8: score += 0.10
    if dir_std > 1.2: score += 0.30
    elif dir_std > 0.8: score += 0.15
    return score, {'laplacian_var': lap_var, 'gradient_std': grad_std, 'direction_std': dir_std}


# =============================================================================
# CHECK 4: Moire Pattern Detection (enhanced for video replay)
# =============================================================================
def detect_moire(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (256, 256)).astype(np.float32)
    fshift = np.fft.fftshift(np.fft.fft2(gray))
    mag = np.abs(fshift)
    h, w = mag.shape
    cy, cx = h // 2, w // 2
    mag[cy-2:cy+3, cx-2:cx+3] = 0
    y, x = np.ogrid[:h, :w]
    dist = np.sqrt((x - cx)**2 + (y - cy)**2)
    ring = mag[(dist >= min(h,w)*0.15) & (dist <= min(h,w)*0.45)]
    if len(ring) == 0: return 0.5, {'peak_ratio': 0.0}
    rm, rs = np.mean(ring), np.std(ring)
    if rs < 1e-10: return 0.8, {'peak_ratio': 0.0}
    peaks = ring > (rm + 4.0 * rs)
    pr = safe_float(np.sum(peaks) / len(ring))
    ps = safe_float(np.mean(ring[peaks]) / (rm + 1e-10)) if np.any(peaks) else 0.0

    # Also check for periodic peaks in high-frequency band (screen pixel grid)
    high_ring = mag[(dist >= min(h,w)*0.35) & (dist <= min(h,w)*0.48)]
    high_rm, high_rs = 0.0, 0.0
    high_peak_ratio = 0.0
    if len(high_ring) > 0:
        high_rm = float(np.mean(high_ring))
        high_rs = float(np.std(high_ring))
        if high_rs > 1e-10:
            high_peaks = high_ring > (high_rm + 3.0 * high_rs)
            high_peak_ratio = safe_float(np.sum(high_peaks) / len(high_ring))

    # Lowered thresholds to catch video replay moire (which is subtler than photo moire)
    if pr > 0.010 and ps > 3.0: score = 0.0
    elif pr > 0.005 or high_peak_ratio > 0.008: score = 0.3
    elif pr > 0.003: score = 0.5
    else: score = 1.0
    return score, {'peak_ratio': pr, 'peak_strength': ps, 'high_freq_peaks': high_peak_ratio}


# =============================================================================
# CHECK 5: Reflection Analysis
# =============================================================================
def analyze_reflections(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (128, 128))
    bright = gray > 200
    bright_ratio = safe_float(np.mean(bright))
    spread = 0.0
    if bright_ratio > 0.01:
        coords = np.where(bright)
        if len(coords[0]) > 5:
            spread = safe_float(np.sqrt(np.var(coords[0]) + np.var(coords[1])))
    bs = 10
    center_mean = safe_float(np.mean(gray[bs:-bs, bs:-bs]))
    border_mean = safe_float(np.mean(np.concatenate([gray[:bs].flatten(), gray[-bs:].flatten(),
                                                      gray[:, :bs].flatten(), gray[:, -bs:].flatten()])))
    bdiff = abs(center_mean - border_mean)
    lum_std = safe_float(np.std(gray.astype(np.float32)))
    score = 0.0
    if lum_std > 35: score += 0.4
    elif lum_std > 25: score += 0.25
    if spread > 20: score += 0.3
    elif spread > 10: score += 0.15
    if bdiff > 10: score += 0.3
    elif bdiff > 5: score += 0.15
    return score, {'luminance_std': lum_std, 'highlight_spread': spread, 'center_border_diff': bdiff}


# =============================================================================
# CHECK 6: LBP Analysis
# =============================================================================
def analyze_lbp(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (128, 128))
    h, w = gray.shape
    c = gray[1:h-1, 1:w-1].astype(np.int16)
    lbp = np.zeros((h-2, w-2), dtype=np.uint8)
    for i, (dy, dx) in enumerate([(- 1,-1),(-1,0),(-1,1),(0,1),(1,1),(1,0),(1,-1),(0,-1)]):
        lbp |= ((gray[1+dy:h-1+dy, 1+dx:w-1+dx] >= c).astype(np.uint8) << (7-i))
    hist = np.histogram(lbp.flatten(), bins=256, range=(0,256))[0].astype(np.float32)
    hist /= (hist.sum() + 1e-10)
    entropy = safe_float(-np.sum(hist * np.log2(hist + 1e-10)))
    uniformity = safe_float(np.sum(hist**2))
    nz = int(np.sum(hist > 0.001))
    score = 0.0
    if entropy > 6.5: score += 0.4
    elif entropy > 5.5: score += 0.25
    elif entropy > 4.5: score += 0.10
    if uniformity < 0.02: score += 0.3
    elif uniformity < 0.04: score += 0.15
    if nz > 200: score += 0.3
    elif nz > 150: score += 0.15
    return score, {'lbp_entropy': entropy, 'lbp_uniformity': uniformity, 'non_zero_bins': nz}


# =============================================================================
# CHECK 7: Focus Gradient Analysis
# =============================================================================
def analyze_focus_gradient(face_img):
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (128, 128))
    h, w = gray.shape
    gs = 4
    ch, cw = h // gs, w // gs
    smap = []
    for r in range(gs):
        for c in range(gs):
            cell = gray[r*ch:(r+1)*ch, c*cw:(c+1)*cw]
            smap.append(safe_float(cv2.Laplacian(cell, cv2.CV_64F).var()))
    smap = np.array(smap)
    if np.max(smap) < 1e-10: return 0.0, {'reason': 'insufficient data'}
    s_mean, s_std = safe_float(np.mean(smap)), safe_float(np.std(smap))
    cv_sharp = s_std / (s_mean + 1e-10)
    ce_ratio = safe_float(np.mean(smap[[5,6,9,10]])) / (safe_float(np.mean(smap[[0,3,12,15]])) + 1e-10)
    score = 0.0
    if cv_sharp > 0.45: score += 0.5
    elif cv_sharp > 0.30: score += 0.35
    elif cv_sharp > 0.20: score += 0.15
    if ce_ratio > 1.3: score += 0.5
    elif ce_ratio > 1.1: score += 0.3
    elif ce_ratio > 0.8: score += 0.1
    return score, {'cv_sharpness': cv_sharp, 'center_edge_ratio': ce_ratio}


# =============================================================================
# CHECK 8: Channel Noise Analysis
# =============================================================================
def analyze_channel_noise(face_img):
    img = cv2.resize(face_img, (128, 128)).astype(np.float32)
    b, g, r = cv2.split(img)
    kern = np.array([[-1,-1,-1],[-1,8,-1],[-1,-1,-1]], dtype=np.float32) / 8.0
    bn, gn, rn = cv2.filter2D(b,-1,kern), cv2.filter2D(g,-1,kern), cv2.filter2D(r,-1,kern)
    b_std, g_std, r_std = safe_float(np.std(bn)), safe_float(np.std(gn)), safe_float(np.std(rn))
    bg_ratio = b_std / (g_std + 1e-10)
    rg_ratio = r_std / (g_std + 1e-10)
    # Safe correlation
    def safe_corr(a, b):
        try:
            v = float(np.corrcoef(a.flatten(), b.flatten())[0, 1])
            return 0.0 if (v != v) else v
        except: return 0.0
    bg_corr = safe_corr(bn, gn)
    rg_corr = safe_corr(rn, gn)
    avg_corr = (bg_corr + rg_corr) / 2
    score = 0.0
    if avg_corr > 0.85: score += 0.5
    elif avg_corr > 0.70: score += 0.3
    elif avg_corr > 0.50: score += 0.1
    ratio_balance = abs(bg_ratio - 1.0) + abs(rg_ratio - 1.0)
    if ratio_balance < 0.3: score += 0.5
    elif ratio_balance < 0.6: score += 0.3
    elif ratio_balance < 1.0: score += 0.1
    return score, {'avg_corr': avg_corr, 'bg_ratio': bg_ratio, 'rg_ratio': rg_ratio}


# =============================================================================
# CHECK 9: Temporal Analysis (Face-Specific Movement)
# =============================================================================
def analyze_temporal(frames_data):
    """
    Analyze movement WITHIN the face region across frames.

    Key insight for phone attack: When someone holds a phone with a photo,
    the WHOLE frame moves (hand movement), but the face ON THE SCREEN is
    rigid — it moves as a solid block. A real face has independent micro-movements
    (eyes blink, lips twitch, head tilts slightly) that create NON-RIGID motion.

    We detect this by:
    1. Aligning frames using the face center (removes global hand motion)
    2. Measuring residual movement after alignment — rigid=low, real=high
    3. Checking if different face zones move independently
    """
    if len(frames_data) < 3: return 0.5, {'reason': 'too few frames'}
    grays = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (128,128)).astype(np.float32) for f in frames_data]

    # --- Part A: Raw movement (same as before) ---
    diffs = [np.abs(grays[i] - grays[i-1]) for i in range(1, len(grays))]
    mads = [safe_float(np.mean(d)) for d in diffs]
    mad_mean = safe_float(np.mean(mads))

    # --- Part B: Aligned movement (removes hand/body global motion) ---
    # Use phase correlation to estimate frame-to-frame shift, then align
    aligned_diffs = []
    for i in range(1, len(grays)):
        try:
            # Phase correlation gives (dx, dy) shift between frames
            shift, _ = cv2.phaseCorrelate(grays[i-1], grays[i])
            dx, dy = shift
            # Build affine matrix to undo the shift
            M = np.float32([[1, 0, -dx], [0, 1, -dy]])
            aligned = cv2.warpAffine(grays[i], M, (128, 128))
            diff = np.abs(aligned - grays[i-1])
            aligned_diffs.append(diff)
        except:
            aligned_diffs.append(diffs[i-1] if i-1 < len(diffs) else np.zeros((128,128), dtype=np.float32))

    aligned_mads = [safe_float(np.mean(d)) for d in aligned_diffs]
    aligned_mad_mean = safe_float(np.mean(aligned_mads))

    # --- Part C: Zone-independent movement (non-rigid motion) ---
    # Divide face into 4 quadrants: top-left (forehead), top-right,
    # bottom-left (mouth), bottom-right (chin)
    # A real face: these zones move independently (eyes blink, mouth moves)
    # A photo: all zones move identically (rigid body)
    zone_movements = {'tl': [], 'tr': [], 'bl': [], 'br': []}
    for d in aligned_diffs:
        h, w = d.shape
        zone_movements['tl'].append(safe_float(np.mean(d[:h//2, :w//2])))
        zone_movements['tr'].append(safe_float(np.mean(d[:h//2, w//2:])))
        zone_movements['bl'].append(safe_float(np.mean(d[h//2:, :w//2])))
        zone_movements['br'].append(safe_float(np.mean(d[h//2:, w//2:])))

    # Compute variance of movement across zones — high variance = non-rigid = real
    zone_means = [np.mean(zone_movements[z]) for z in zone_movements]
    zone_variance = safe_float(np.std(zone_means))

    # Compute cross-zone correlation — real faces have lower correlation (independent movement)
    zone_arrays = [np.array(zone_movements[z]) for z in zone_movements]
    zone_corrs = []
    for i in range(len(zone_arrays)):
        for j in range(i+1, len(zone_arrays)):
            try:
                c = float(np.corrcoef(zone_arrays[i], zone_arrays[j])[0,1])
                if c != c: c = 1.0  # NaN → treat as perfectly correlated (rigid)
                zone_corrs.append(c)
            except:
                zone_corrs.append(1.0)
    avg_zone_corr = safe_float(np.mean(zone_corrs)) if zone_corrs else 1.0

    # --- Scoring ---
    score = 0.0

    # A) Raw movement — must have SOME movement
    if mad_mean > 2.5: score += 0.15
    elif mad_mean > 1.5: score += 0.10
    elif mad_mean > 1.0: score += 0.02

    # B) Aligned movement — after removing global shift, real faces still show residual
    # Phone photo: aligned_mad ≈ 0.3-0.8 (only JPEG noise remains after alignment)
    # Real face:   aligned_mad ≈ 1.5-5.0 (actual facial micro-movements)
    if aligned_mad_mean > 2.0: score += 0.35
    elif aligned_mad_mean > 1.2: score += 0.20
    elif aligned_mad_mean > 0.8: score += 0.05
    # Very low aligned movement = rigid body = photo
    # No points added if < 0.8

    # C) Non-rigid motion (zone independence)
    # Real face: zone_variance > 0.3, avg_zone_corr < 0.85
    # Photo: zone_variance ≈ 0, avg_zone_corr ≈ 0.99 (all zones move together)
    if zone_variance > 0.5: score += 0.25
    elif zone_variance > 0.2: score += 0.15
    elif zone_variance > 0.1: score += 0.05

    if avg_zone_corr < 0.7: score += 0.25
    elif avg_zone_corr < 0.85: score += 0.15
    elif avg_zone_corr < 0.95: score += 0.05

    return score, {
        'mad_mean': mad_mean, 'aligned_mad_mean': aligned_mad_mean,
        'zone_variance': zone_variance, 'avg_zone_corr': avg_zone_corr,
    }


# =============================================================================
# CHECK 10: Screen Edge / Bezel Detection
# =============================================================================
def detect_screen_edges(face_img):
    """
    Detect sharp rectangular edges within the face region that indicate
    a screen bezel or phone border.

    When someone holds a phone to the camera, the face crop often contains
    parts of the phone bezel — straight horizontal/vertical lines that
    don't exist on real faces.

    Uses Hough Line Transform to find strong straight lines.
    """
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (256, 256))

    # Edge detection
    edges = cv2.Canny(gray, 50, 150)

    # Hough line detection — look for strong straight lines
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=80,
                            minLineLength=80, maxLineGap=10)

    if lines is None:
        return 1.0, {'line_count': 0, 'long_lines': 0}  # No lines = probably real

    # Count lines and their properties
    line_count = len(lines)
    long_lines = 0
    horizontal_lines = 0
    vertical_lines = 0

    for line in lines:
        x1, y1, x2, y2 = line[0]
        length = np.sqrt((x2-x1)**2 + (y2-y1)**2)
        angle = abs(np.arctan2(y2-y1, x2-x1 + 1e-10))

        if length > 100:
            long_lines += 1

        # Near-horizontal (angle close to 0 or pi)
        if angle < 0.15 or angle > np.pi - 0.15:
            horizontal_lines += 1
        # Near-vertical (angle close to pi/2)
        elif abs(angle - np.pi/2) < 0.15:
            vertical_lines += 1

    # Phone bezels create multiple long straight lines (horizontal + vertical)
    # Real faces have few if any straight lines
    has_bezel = (long_lines >= 2) or (horizontal_lines >= 2 and vertical_lines >= 1)

    if has_bezel:
        score = 0.0
    elif long_lines >= 1:
        score = 0.3
    elif line_count > 5:
        score = 0.6
    else:
        score = 1.0

    return score, {
        'line_count': line_count, 'long_lines': long_lines,
        'horizontal': horizontal_lines, 'vertical': vertical_lines,
    }


# =============================================================================
# CHECK 11: Screen Illumination Pattern
# =============================================================================
def analyze_screen_illumination(face_img):
    """
    Detect uniform backlighting pattern typical of screens.

    Screens emit light uniformly from behind → face appears evenly lit.
    Real faces under ambient light have natural shadows and gradients
    (one side brighter, nose shadow, eye sockets darker, etc.)

    We measure:
    1. Left-right luminance asymmetry (real faces have some)
    2. Top-bottom gradient (real faces often have forehead brighter, chin darker)
    3. Center surround difference (real noses are brighter than cheeks)
    """
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (128, 128)).astype(np.float32)
    h, w = gray.shape

    # Left-right asymmetry
    left_half = np.mean(gray[:, :w//2])
    right_half = np.mean(gray[:, w//2:])
    lr_asymmetry = safe_float(abs(left_half - right_half))

    # Top-bottom gradient
    top_third = np.mean(gray[:h//3, :])
    bottom_third = np.mean(gray[2*h//3:, :])
    tb_gradient = safe_float(abs(top_third - bottom_third))

    # Center vs surround
    center = gray[h//4:3*h//4, w//4:3*w//4]
    surround_top = gray[:h//4, :]
    surround_bot = gray[3*h//4:, :]
    surround_left = gray[:, :w//4]
    surround_right = gray[:, 3*w//4:]
    center_mean = safe_float(np.mean(center))
    surround_mean = safe_float(np.mean(np.concatenate([
        surround_top.flatten(), surround_bot.flatten(),
        surround_left.flatten(), surround_right.flatten()
    ])))
    cs_diff = safe_float(abs(center_mean - surround_mean))

    # Local contrast variation — real faces have lots of local contrast variation
    # Screens produce more uniform local contrast
    blocks = []
    bs = 16
    for r in range(0, h - bs, bs):
        for c in range(0, w - bs, bs):
            block = gray[r:r+bs, c:c+bs]
            blocks.append(safe_float(np.std(block)))
    contrast_variance = safe_float(np.std(blocks)) if blocks else 0.0

    # Scoring
    score = 0.0

    # L-R asymmetry: real faces typically > 3 pixels, screens < 2
    if lr_asymmetry > 5: score += 0.25
    elif lr_asymmetry > 2: score += 0.15

    # T-B gradient: real faces have > 3
    if tb_gradient > 5: score += 0.25
    elif tb_gradient > 2: score += 0.15

    # Center-surround: real faces (nose protrudes, catches more light)
    if cs_diff > 5: score += 0.25
    elif cs_diff > 2: score += 0.10

    # Local contrast variation: real faces > 8, screens < 5
    if contrast_variance > 10: score += 0.25
    elif contrast_variance > 5: score += 0.15
    elif contrast_variance > 3: score += 0.05

    return score, {
        'lr_asymmetry': lr_asymmetry, 'tb_gradient': tb_gradient,
        'cs_diff': cs_diff, 'contrast_variance': contrast_variance,
    }


# =============================================================================
# CHECK 12: Screen Color Temperature (Blue Shift Detection)
# =============================================================================
def analyze_color_temperature(face_img):
    """
    Screens emit blue-shifted light compared to natural ambient light.
    When a face is displayed on a phone screen and filmed by webcam,
    the skin has a subtle blue/cool color cast that doesn't match
    natural warm ambient lighting on real skin.

    We measure:
    1. Blue channel dominance relative to red (screens are blue-heavy)
    2. Color temperature of skin pixels (warm = real, cool = screen)
    3. Saturation reduction (screen recapture reduces saturation)
    """
    img = cv2.resize(face_img, (128, 128))
    b, g, r = cv2.split(img.astype(np.float32))

    # Skin pixel mask (YCrCb)
    ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[:, :, 1].astype(np.float32)
    cb = ycrcb[:, :, 2].astype(np.float32)
    skin_mask = (cr >= 130) & (cr <= 175) & (cb >= 75) & (cb <= 130)
    skin_count = int(np.sum(skin_mask))

    if skin_count < 200:
        return 0.5, {'reason': 'insufficient skin pixels', 'skin_count': skin_count}

    # Blue-to-red ratio on skin pixels (screens have higher blue)
    skin_b = b[skin_mask]
    skin_r = r[skin_mask]
    skin_g = g[skin_mask]
    br_ratio = safe_float(np.mean(skin_b) / (np.mean(skin_r) + 1e-10))

    # Color warmth: (R - B) on skin. Real skin is warm (positive), screen is cooler
    warmth = safe_float(np.mean(skin_r - skin_b))

    # Saturation of skin pixels in HSV
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    skin_sat = hsv[:, :, 1][skin_mask].astype(np.float32)
    avg_sat = safe_float(np.mean(skin_sat))
    sat_std = safe_float(np.std(skin_sat))

    # Green tint detection (some screens have green tint)
    gr_ratio = safe_float(np.mean(skin_g) / (np.mean(skin_r) + 1e-10))

    # Scoring: real skin is warm, saturated, and has natural color variation
    score = 0.0

    # Warmth: real skin typically R > B by 15+ points
    if warmth > 20: score += 0.3
    elif warmth > 10: score += 0.2
    elif warmth > 3: score += 0.1
    # Very cool skin (warmth < 3) → likely screen → 0 points

    # Blue-red ratio: real skin < 0.85, screen can push > 0.90
    if br_ratio < 0.80: score += 0.25
    elif br_ratio < 0.90: score += 0.15
    elif br_ratio < 0.95: score += 0.05
    # ratio >= 0.95 → very blue → screen-like → 0 points

    # Saturation: real faces have moderate-high saturation with good variance
    if avg_sat > 50 and sat_std > 20: score += 0.25
    elif avg_sat > 35 and sat_std > 15: score += 0.15
    elif avg_sat > 20: score += 0.05

    # Green tint: excessive green relative to red suggests screen
    if gr_ratio < 0.95: score += 0.2
    elif gr_ratio < 1.0: score += 0.1

    return score, {
        'warmth': warmth, 'br_ratio': br_ratio,
        'avg_saturation': avg_sat, 'sat_std': sat_std,
        'gr_ratio': gr_ratio, 'skin_count': skin_count,
    }


# =============================================================================
# CHECK 13: Temporal Flicker / Refresh Rate Detection
# =============================================================================
def detect_temporal_flicker(frames_data):
    """
    Phone screens refresh at 60Hz (or 120Hz). When filmed by a 30fps camera,
    the screen refresh creates periodic brightness fluctuations (beat frequency).

    This creates a characteristic periodic pattern in frame-to-frame brightness:
    - Real face: brightness varies smoothly and irregularly
    - Screen replay: brightness has periodic ripple from refresh rate beating

    We detect this by:
    1. Computing mean brightness per frame
    2. FFT of the brightness time-series
    3. Checking for periodic peaks (screen flicker has consistent periodicity)
    4. Also checking brightness variance pattern (screens are more uniform frame-to-frame)
    """
    if len(frames_data) < 5:
        return 0.5, {'reason': 'too few frames for flicker analysis'}

    # Get mean brightness of face region per frame
    brightness = []
    for f in frames_data:
        gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        brightness.append(safe_float(np.mean(gray)))

    brightness = np.array(brightness, dtype=np.float64)
    n = len(brightness)

    # Remove DC component (mean) and linear trend
    x = np.arange(n, dtype=np.float64)
    if n > 2:
        coeffs = np.polyfit(x, brightness, 1)
        trend = np.polyval(coeffs, x)
        detrended = brightness - trend
    else:
        detrended = brightness - np.mean(brightness)

    # Overall brightness variance (screens tend to have more uniform brightness)
    brightness_std = safe_float(np.std(brightness))

    # FFT of detrended brightness series
    fft_vals = np.abs(np.fft.rfft(detrended))
    if len(fft_vals) > 1:
        fft_vals[0] = 0  # Remove DC
    fft_vals = fft_vals.astype(np.float64)

    # Check for periodicity: ratio of peak to mean (screen flicker → strong peak)
    if len(fft_vals) > 1 and np.mean(fft_vals[1:]) > 1e-10:
        peak_val = safe_float(np.max(fft_vals[1:]))
        mean_val = safe_float(np.mean(fft_vals[1:]))
        periodicity = safe_float(peak_val / (mean_val + 1e-10))
    else:
        periodicity = 1.0

    # Frame-to-frame brightness change pattern
    diffs = np.diff(brightness)
    diff_std = safe_float(np.std(diffs))

    # Autocorrelation of brightness changes (periodic flicker → high autocorrelation at lag)
    autocorr_max = 0.0
    if len(diffs) > 3:
        for lag in range(1, min(len(diffs) // 2, 5)):
            try:
                c = float(np.corrcoef(diffs[:-lag], diffs[lag:])[0, 1])
                if c == c:  # not NaN
                    autocorr_max = max(autocorr_max, abs(c))
            except:
                pass
    autocorr_max = safe_float(autocorr_max)

    # Scoring: real faces have irregular brightness changes, screens have periodic flicker
    score = 0.0

    # Low periodicity in FFT = real (no screen refresh beat)
    if periodicity < 2.0: score += 0.35
    elif periodicity < 3.5: score += 0.20
    elif periodicity < 5.0: score += 0.10
    # High periodicity → screen flicker → 0 points

    # Low autocorrelation = real (no repeating pattern)
    if autocorr_max < 0.3: score += 0.35
    elif autocorr_max < 0.5: score += 0.20
    elif autocorr_max < 0.7: score += 0.10
    # High autocorrelation → periodic flicker → 0 points

    # Some brightness variation is expected for real faces (not too uniform)
    if brightness_std > 2.0: score += 0.15
    elif brightness_std > 0.8: score += 0.10
    elif brightness_std > 0.3: score += 0.05

    # Non-uniform brightness changes (real faces are irregular)
    if diff_std > 1.5: score += 0.15
    elif diff_std > 0.5: score += 0.10

    return score, {
        'periodicity': periodicity, 'autocorr_max': autocorr_max,
        'brightness_std': brightness_std, 'diff_std': diff_std,
    }


# =============================================================================
# CHECK 14: Screen Pixel Grid / Subpixel Pattern Detection
# =============================================================================
def detect_screen_pixels(face_img):
    """
    When a camera captures a screen, the screen's pixel grid creates a
    characteristic high-frequency periodic pattern that's different from
    natural image textures.

    We detect this by:
    1. Looking for periodic peaks in the 2D FFT (pixel grid = regular spacing)
    2. Analyzing horizontal and vertical frequency separately (screens have
       strong H+V periodic structure from pixel columns/rows)
    3. Measuring the ratio of energy in periodic peaks vs. overall energy
    """
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (256, 256)).astype(np.float32)

    # Apply high-pass filter to isolate fine detail (pixel grid is high-frequency)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    highpass = gray - blur

    # 2D FFT of high-pass filtered image
    fshift = np.fft.fftshift(np.fft.fft2(highpass))
    mag = np.abs(fshift)
    h, w = mag.shape
    cy, cx = h // 2, w // 2

    # Zero out DC and very low frequencies
    mag[cy-3:cy+4, cx-3:cx+4] = 0

    # Analyze horizontal and vertical frequency axes separately
    # Screen pixels create strong peaks along horizontal and vertical axes
    h_axis = mag[cy, cx+5:]  # horizontal frequencies
    v_axis = mag[cy+5:, cx]  # vertical frequencies

    # Peak-to-mean ratio along each axis (periodic peaks from pixel grid)
    h_peak_ratio = 0.0
    v_peak_ratio = 0.0
    if len(h_axis) > 3:
        h_mean = safe_float(np.mean(h_axis))
        h_max = safe_float(np.max(h_axis))
        h_peak_ratio = safe_float(h_max / (h_mean + 1e-10))
    if len(v_axis) > 3:
        v_mean = safe_float(np.mean(v_axis))
        v_max = safe_float(np.max(v_axis))
        v_peak_ratio = safe_float(v_max / (v_mean + 1e-10))

    # Combined peak ratio (screen has strong peaks in both directions)
    combined_peak = (h_peak_ratio + v_peak_ratio) / 2.0

    # Energy concentration: screens have energy concentrated at specific frequencies
    # vs. natural textures which have diffuse energy distribution
    total_energy = safe_float(np.sum(mag))
    if total_energy > 1e-10:
        # Top N% of pixels by magnitude
        threshold = np.percentile(mag, 95)
        peak_energy = safe_float(np.sum(mag[mag > threshold]))
        energy_concentration = safe_float(peak_energy / total_energy)
    else:
        energy_concentration = 0.0

    # Check for regular spacing in peaks (pixel grid creates evenly-spaced peaks)
    regularity = 0.0
    for axis_data in [h_axis, v_axis]:
        if len(axis_data) > 10:
            ad = axis_data.astype(np.float64)
            mean_a = np.mean(ad)
            std_a = np.std(ad)
            if std_a > 1e-10:
                peaks_idx = np.where(ad > mean_a + 2 * std_a)[0]
                if len(peaks_idx) > 2:
                    spacings = np.diff(peaks_idx)
                    if len(spacings) > 1 and np.mean(spacings) > 0:
                        spacing_cv = safe_float(np.std(spacings) / (np.mean(spacings) + 1e-10))
                        # Low CV = regular spacing = pixel grid
                        regularity = max(regularity, 1.0 - spacing_cv)

    # Scoring: natural faces have diffuse high-frequency content,
    # screens have concentrated periodic peaks
    score = 0.0

    # Low combined peak ratio = natural texture = real
    if combined_peak < 3.0: score += 0.35
    elif combined_peak < 5.0: score += 0.20
    elif combined_peak < 8.0: score += 0.10
    # Very high peak ratio → pixel grid → screen

    # Low energy concentration = diffuse = real
    if energy_concentration < 0.15: score += 0.30
    elif energy_concentration < 0.25: score += 0.15
    elif energy_concentration < 0.35: score += 0.05

    # Low regularity = irregular peaks = real
    if regularity < 0.3: score += 0.35
    elif regularity < 0.5: score += 0.20
    elif regularity < 0.7: score += 0.10
    # High regularity → evenly-spaced peaks → pixel grid → screen

    return score, {
        'h_peak_ratio': h_peak_ratio, 'v_peak_ratio': v_peak_ratio,
        'combined_peak': combined_peak, 'energy_concentration': energy_concentration,
        'regularity': regularity,
    }


# =============================================================================
# CHECK 15: Color Banding / Reduced Color Depth Detection
# =============================================================================
def detect_color_banding(face_img):
    """
    When video is displayed on a screen and recaptured by camera, there's a
    loss in color depth. Screens display 8-bit per channel, but the camera's
    sensor + screen gamma creates visible banding in smooth gradient areas.

    Also, screen recapture introduces:
    1. Reduced unique color count in smooth regions (quantization)
    2. Sharp transitions where smooth gradients should be (banding)
    3. More uniform noise pattern (sensor noise becomes correlated)

    Real faces have smoother gradients (continuous skin tones).
    """
    img = cv2.resize(face_img, (128, 128))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Count unique intensity levels in smooth regions (skin areas)
    # Smooth regions on real faces have many unique values; screen recapture has fewer
    ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[:, :, 1].astype(np.float32)
    cb = ycrcb[:, :, 2].astype(np.float32)
    skin_mask = (cr >= 130) & (cr <= 175) & (cb >= 75) & (cb <= 130)

    skin_gray = gray[skin_mask]
    skin_count = int(len(skin_gray))

    if skin_count < 200:
        return 0.5, {'reason': 'insufficient skin pixels', 'skin_count': skin_count}

    # Unique intensity values in skin region
    unique_values = len(np.unique(skin_gray))
    unique_ratio = safe_float(unique_values / (skin_count + 1e-10))

    # Gradient smoothness: compute differences between adjacent pixels
    # Real skin has smooth gradients; screen recapture has step-like transitions
    skin_float = gray.astype(np.float32)
    dx = np.abs(np.diff(skin_float, axis=1))
    dy = np.abs(np.diff(skin_float, axis=0))

    # In smooth regions (low gradient), count how many have exact 0 or 1 difference
    # Screen recapture creates more "flat" patches with identical values
    flat_mask_x = dx < 1.0
    flat_mask_y = dy < 1.0
    flat_ratio = safe_float((np.sum(flat_mask_x) + np.sum(flat_mask_y)) /
                             (flat_mask_x.size + flat_mask_y.size + 1e-10))

    # Histogram of gradient magnitudes in smooth regions
    # Real: smooth distribution; Screen: spiky (many 0s, then jumps)
    gradients = np.concatenate([dx.flatten(), dy.flatten()])
    small_grads = gradients[gradients < 10]  # Only smooth areas
    if len(small_grads) > 100:
        grad_hist = np.histogram(small_grads, bins=20, range=(0, 10))[0].astype(np.float32)
        grad_hist /= (grad_hist.sum() + 1e-10)
        grad_entropy = safe_float(-np.sum(grad_hist * np.log2(grad_hist + 1e-10)))
    else:
        grad_entropy = 3.0

    # Color channel correlation in skin region
    # Screen recapture: channels become more correlated (color depth loss)
    b, g, r = cv2.split(img.astype(np.float32))
    skin_b, skin_g, skin_r = b[skin_mask], g[skin_mask], r[skin_mask]
    if len(skin_b) > 100:
        try:
            bg_corr = safe_float(float(np.corrcoef(skin_b, skin_g)[0, 1]))
            rg_corr = safe_float(float(np.corrcoef(skin_r, skin_g)[0, 1]))
        except:
            bg_corr, rg_corr = 0.9, 0.9
        skin_channel_corr = (bg_corr + rg_corr) / 2.0
    else:
        skin_channel_corr = 0.9

    # Scoring
    score = 0.0

    # High unique ratio = smooth gradient = real
    if unique_ratio > 0.3: score += 0.25
    elif unique_ratio > 0.15: score += 0.15
    elif unique_ratio > 0.08: score += 0.05

    # Low flat ratio = more gradient variation = real
    if flat_ratio < 0.3: score += 0.25
    elif flat_ratio < 0.5: score += 0.15
    elif flat_ratio < 0.7: score += 0.05

    # High gradient entropy = smooth distribution = real
    if grad_entropy > 3.5: score += 0.25
    elif grad_entropy > 2.5: score += 0.15
    elif grad_entropy > 1.8: score += 0.05

    # Lower skin channel correlation = more natural color variation = real
    if skin_channel_corr < 0.85: score += 0.25
    elif skin_channel_corr < 0.92: score += 0.15
    elif skin_channel_corr < 0.97: score += 0.05

    return score, {
        'unique_values': unique_values, 'unique_ratio': unique_ratio,
        'flat_ratio': flat_ratio, 'grad_entropy': grad_entropy,
        'skin_channel_corr': skin_channel_corr,
    }


# =============================================================================
# MAIN: Combined Analysis
# =============================================================================
def analyze_liveness(frames_b64):
    print(f"[ANALYZE] Starting with {len(frames_b64)} frames", flush=True)

    images = []
    for i, b64 in enumerate(frames_b64):
        try:
            img = decode_base64_image(b64)
            if img is not None:
                images.append(img)
            else:
                print(f"  [WARN] Frame {i}: decode returned None", flush=True)
        except Exception as e:
            print(f"  [WARN] Frame {i}: {e}", flush=True)

    print(f"[ANALYZE] Decoded {len(images)}/{len(frames_b64)} frames", flush=True)
    if len(images) < 1:
        return {'success': False, 'isLive': False, 'confidence': 0, 'message': 'No valid images'}

    print(f"[ANALYZE] First image shape: {images[0].shape}", flush=True)

    # Detect face
    face_rect = None
    for img in images:
        face_rect = detect_face_region(img)
        if face_rect: break

    if face_rect:
        print(f"[ANALYZE] Face detected: {face_rect}", flush=True)
        face_crops = []
        for img in images:
            try:
                fc = crop_face(img, face_rect, margin=0.2)
                if fc.shape[0] > 30 and fc.shape[1] > 30:
                    face_crops.append(fc)
            except: pass
    else:
        print("[ANALYZE] No face by Haar, using center crop", flush=True)
        face_crops = []

    if len(face_crops) < 1:
        face_crops = []
        for img in images:
            h, w = img.shape[:2]
            mx, my = int(w * 0.15), int(h * 0.10)
            crop = img[my:h-my, mx:w-mx]
            if crop.shape[0] > 30 and crop.shape[1] > 30:
                face_crops.append(crop)

    if len(face_crops) < 1:
        return {'success': False, 'isLive': False, 'confidence': 0, 'message': 'Could not process frames'}

    primary = face_crops[len(face_crops) // 2]
    print(f"[ANALYZE] Running 15 checks on {primary.shape}, {len(face_crops)} crops", flush=True)

    checks = {}
    def safe_check(name, fn, *args):
        try:
            s, d = fn(*args)
            checks[name] = {'score': s, 'detail': d}
            print(f"  {name}: {s:.3f}", flush=True)
            return s
        except Exception as e:
            print(f"  {name}: ERROR - {e}", flush=True)
            traceback.print_exc()
            checks[name] = {'score': 0.0, 'detail': {'error': str(e)}}
            return 0.0

    # Original checks
    freq_score = safe_check('frequency', analyze_frequency, primary)
    color_score = safe_check('color', analyze_color_distribution, primary)
    texture_score = safe_check('texture', analyze_texture, primary)
    moire_score = safe_check('moire', detect_moire, primary)
    reflection_score = safe_check('reflection', analyze_reflections, primary)
    lbp_score = safe_check('lbp', analyze_lbp, primary)
    channel_score = safe_check('channel_noise', analyze_channel_noise, primary)
    focus_score = safe_check('focus_gradient', analyze_focus_gradient, primary)
    screen_edge_score = safe_check('screen_edges', detect_screen_edges, primary)
    screen_light_score = safe_check('screen_illumination', analyze_screen_illumination, primary)
    temporal_score = safe_check('temporal', analyze_temporal, face_crops) if len(face_crops) >= 3 else 0.3
    if 'temporal' not in checks:
        checks['temporal'] = {'score': temporal_score, 'detail': {'reason': 'too few crops'}}

    # NEW: Video replay-specific checks
    color_temp_score = safe_check('color_temperature', analyze_color_temperature, primary)
    flicker_score = safe_check('temporal_flicker', detect_temporal_flicker, face_crops) if len(face_crops) >= 5 else 0.5
    if 'temporal_flicker' not in checks:
        checks['temporal_flicker'] = {'score': flicker_score, 'detail': {'reason': 'too few crops'}}
    pixel_grid_score = safe_check('screen_pixels', detect_screen_pixels, primary)
    banding_score = safe_check('color_banding', detect_color_banding, primary)

    # Weights: balanced across all 15 checks
    # Screen-detection + temporal checks get the most weight since they're most discriminative
    weights = {
        'frequency': 0.03,
        'color': 0.03,
        'texture': 0.04,
        'moire': 0.06,                # Enhanced for video replay
        'reflection': 0.03,
        'lbp': 0.03,
        'channel_noise': 0.04,
        'focus_gradient': 0.07,
        'screen_edges': 0.08,         # Screen bezel detection
        'screen_illumination': 0.07,  # Screen uniform lighting
        'temporal': 0.18,             # Face-specific non-rigid motion
        'color_temperature': 0.10,    # NEW: Screen blue-shift
        'temporal_flicker': 0.10,     # NEW: Screen refresh rate flicker
        'screen_pixels': 0.08,        # NEW: Pixel grid artifacts
        'color_banding': 0.06,        # NEW: Color depth loss
    }

    confidence = int(round(sum(checks[k]['score'] * weights[k] for k in weights) * 100))

    # --- HARD GATES ---
    # Gate 1: Temporal — aligned face movement must show non-rigid motion
    temporal_gate = temporal_score >= 0.30

    # Gate 2: Focus gradient — 3D faces have depth-of-field variation
    focus_gate = focus_score >= 0.15

    # Gate 3: Screen edge — if strong screen bezel detected, reject
    screen_gate = screen_edge_score >= 0.15

    # Gate 4: Screen composite — combine multiple screen-detection signals
    # If 3+ screen indicators flag it, reject even if individual scores are borderline
    screen_signals = 0
    if color_temp_score < 0.30: screen_signals += 1
    if pixel_grid_score < 0.30: screen_signals += 1
    if banding_score < 0.30: screen_signals += 1
    if screen_light_score < 0.30: screen_signals += 1
    if moire_score < 0.40: screen_signals += 1
    if flicker_score < 0.30: screen_signals += 1
    screen_composite_gate = screen_signals < 3
    if not screen_composite_gate:
        print(f"  >>> HARD REJECT: screen_composite ({screen_signals}/6 flags)", flush=True)

    is_live = confidence >= 50 and temporal_gate and focus_gate and screen_gate and screen_composite_gate

    if not temporal_gate: print(f"  >>> HARD REJECT: temporal={temporal_score:.2f}", flush=True)
    if not focus_gate: print(f"  >>> HARD REJECT: focus={focus_score:.2f}", flush=True)
    if not screen_gate: print(f"  >>> HARD REJECT: screen_edges={screen_edge_score:.2f}", flush=True)
    print(f"[RESULT] confidence={confidence}%, isLive={is_live}, screen_signals={screen_signals}/6", flush=True)

    if is_live: msg = 'Liveness verified - real person detected'
    elif not temporal_gate: msg = 'No natural facial movement detected. Please look at the camera naturally.'
    elif not screen_gate: msg = 'Screen or device border detected. Please do not use a photo or video.'
    elif not screen_composite_gate: msg = 'Screen display detected. Please do not use a phone screen.'
    elif not focus_gate: msg = 'Image appears flat. Please look directly at the camera.'
    else: msg = f'Liveness check failed ({confidence}%). Please try again looking directly at the camera.'

    return to_python({
        'success': True, 'isLive': bool(is_live), 'confidence': confidence, 'message': msg,
        'checks': {
            'textureAnalysis': texture_score > 0.5, 'depthEstimation': focus_score > 0.3,
            'microMovement': temporal_gate, 'blinkDetected': temporal_score > 0.4,
            'screenDetected': not screen_composite_gate,
            'overallScore': confidence,
        },
        'details': {k: {'score': float(v['score']), **{dk: float(dv) if isinstance(dv, (int, float, np.floating, np.integer)) else dv for dk, dv in v.get('detail', {}).items()}} for k, v in checks.items()},
    })


# =============================================================================
# HTTP Server (raw — no Flask, no Werkzeug)
# =============================================================================
class AntiSpoofHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler for anti-spoofing service."""

    def log_message(self, format, *args):
        """Override to print to stdout with flush."""
        print(f"[HTTP] {args[0]}", flush=True)

    def _send_json(self, status, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Content-Length')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {'status': 'ok', 'service': 'antispoof'})
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/analyze':
            self._send_json(404, {'error': 'Not found'})
            return

        print(f"\n[REQUEST] POST /analyze", flush=True)
        try:
            # Read body
            content_length = int(self.headers.get('Content-Length', 0))
            print(f"[REQUEST] Content-Length: {content_length} bytes ({content_length/(1024*1024):.2f} MB)", flush=True)

            if content_length == 0:
                self._send_json(400, {'success': False, 'isLive': False, 'confidence': 0, 'message': 'Empty body'})
                return

            raw_body = self.rfile.read(content_length)
            print(f"[REQUEST] Read {len(raw_body)} bytes", flush=True)

            # Parse JSON
            try:
                data = json.loads(raw_body)
            except json.JSONDecodeError as e:
                print(f"[ERROR] JSON parse: {e}", flush=True)
                self._send_json(400, {'success': False, 'isLive': False, 'confidence': 0, 'message': f'Invalid JSON: {str(e)[:100]}'})
                return

            frames = data.get('frames', [])
            print(f"[REQUEST] {len(frames)} frames, first length: {len(frames[0]) if frames else 0}", flush=True)

            if not frames or len(frames) < 3:
                self._send_json(400, {'success': False, 'isLive': False, 'confidence': 0, 'message': f'Need >= 3 frames, got {len(frames)}'})
                return

            # Run analysis
            result = analyze_liveness(frames)

            # Verify JSON serializable
            result = to_python(result)
            try:
                json.dumps(result)
            except (TypeError, ValueError) as e:
                print(f"[ERROR] JSON serialize: {e}", flush=True)
                # Nuclear option: stringify everything
                result = json.loads(json.dumps(result, default=str))

            print(f"[RESPONSE] isLive={result.get('isLive')}, confidence={result.get('confidence')}", flush=True)
            self._send_json(200, result)

        except Exception as e:
            print(f"[ERROR] {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            self._send_json(500, {'success': False, 'isLive': False, 'confidence': 0, 'message': f'Server error: {str(e)}'})


if __name__ == '__main__':
    port = int(os.environ.get('ANTISPOOF_PORT', 5002))
    print("=" * 60, flush=True)
    print("Anti-Spoofing Liveness Service (raw HTTP)", flush=True)
    print("=" * 60, flush=True)
    print(f"  Port:     {port}", flush=True)
    print(f"  Python:   {sys.version}", flush=True)
    print(f"  OpenCV:   {cv2.__version__}", flush=True)
    print(f"  NumPy:    {np.__version__}", flush=True)
    print(f"  Server:   http.server (no Flask)", flush=True)
    print("=" * 60, flush=True)

    server = HTTPServer(('0.0.0.0', port), AntiSpoofHandler)
    print(f"Listening on http://0.0.0.0:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...", flush=True)
        server.shutdown()
