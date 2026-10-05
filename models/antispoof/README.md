# Face anti-spoofing model (web app live check)

`minifasnet_v2.onnx` — **MiniFASNet-V2** from minivision-ai / Silent-Face-Anti-Spoofing
(Apache-2.0, attribution: Beijing Mininglamp Vision Technology Co., Ltd.), ONNX export from
https://huggingface.co/garciafido/minifasnet-v2-anti-spoofing-onnx — the same file Smart Branch uses.

- SHA-256: `d7b3cd9ba8a7ceb13baa8c4720902e27ca3112eff52f926c08804af6b6eecc7b`
- Run by `services/livenessWorker.js` with `onnxruntime-node` (CPU, ~5 ms per face). If the runtime
  or this file is missing, the live check still works and records "anti-spoof not available".

## Preprocessing (measured — differs from the model card)

Input `[1, 3, 80, 80]` float32, **BGR, raw 0-255** (not divided by 255), cropped 2.7 × the face box
around its centre (scale reduced / box shifted when it would leave the image, as in the original
code), resized to 80 × 80. Output: 3 logits → softmax; **index 1 = real face**.

The model card says "÷ 255, index 0 = live". With ÷ 255 the output does not depend on the image at
all (identical logits for two different faces, ≈ 0.000 live), so a gate built that way rejects
everyone. With raw 0-255 input the scores follow the image: a real photo scored 0.99 live; a photo
shown to the camera (printed / pasted onto a background) scored 0.001.

## Calibrate, then enforce

By default the score is **recorded** with the application (KYC sees it) but does not block. After
checking scores from real customers' phones (live faces should be high, photos/screens low), turn it on
in the Fayda backend's `.env`:

```
ANTISPOOF_ENFORCE=true
ANTISPOOF_THRESHOLD=0.5
```
