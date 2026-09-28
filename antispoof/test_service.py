"""Quick test script to verify the antispoof service works."""
import requests
import base64
import numpy as np
import cv2
import sys

SERVICE_URL = "http://localhost:5002"

def create_test_frame(width=640, height=480, noise_level=10):
    """Create a synthetic face-like test image."""
    img = np.full((height, width, 3), [130, 160, 200], dtype=np.uint8)
    noise = np.random.randint(-noise_level, noise_level, img.shape, dtype=np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    cv2.ellipse(img, (width//2, height//2), (120, 160), 0, 0, 360, (150, 180, 210), -1)
    cv2.circle(img, (width//2 - 50, height//2 - 30), 15, (50, 50, 50), -1)
    cv2.circle(img, (width//2 + 50, height//2 - 30), 15, (50, 50, 50), -1)
    cv2.ellipse(img, (width//2, height//2 + 60), (40, 15), 0, 0, 180, (80, 80, 150), -1)
    return img

def img_to_base64(img):
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf).decode('utf-8')

print("=" * 50)
print("Anti-Spoofing Service Test")
print("=" * 50)

# Test health
print("\n1) Testing GET /health...")
try:
    r = requests.get(f"{SERVICE_URL}/health", timeout=5)
    print(f"   Status: {r.status_code} => {r.json()}")
except Exception as e:
    print(f"   FAILED: {e}")
    print("   Service not running! Start with: python antispoof/antispoof_service.py")
    sys.exit(1)

# Test analyze
print("\n2) Testing POST /analyze with 10 synthetic frames...")
frames = [img_to_base64(create_test_frame(noise_level=10 + i*2)) for i in range(10)]
payload = {"frames": frames}
payload_bytes = len(json.dumps(payload).encode()) if 'json' in dir() else 0
import json
payload_bytes = len(json.dumps(payload).encode())
print(f"   Payload: {payload_bytes} bytes ({payload_bytes/1024:.1f} KB)")
print(f"   Frames: {len(frames)}, first frame: {len(frames[0])} chars")

try:
    r = requests.post(f"{SERVICE_URL}/analyze", json=payload, timeout=60)
    print(f"   Status: {r.status_code}")
    if r.status_code == 200:
        d = r.json()
        print(f"   isLive: {d.get('isLive')}")
        print(f"   confidence: {d.get('confidence')}%")
        print(f"   message: {d.get('message')}")
        if d.get('details'):
            print("   Checks:")
            for k, v in d['details'].items():
                print(f"     {k}: {v.get('score', '?')}")
        print("\n   SUCCESS!")
    else:
        print(f"   ERROR: {r.text[:300]}")
except Exception as e:
    print(f"   FAILED: {e}")

print("\nDone.")
