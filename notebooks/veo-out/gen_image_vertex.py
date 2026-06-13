#!/usr/bin/env python3
"""Generate an image via Vertex AI Imagen (gcloud auth). The Gemini API key is
expired, so we go through Vertex on project openai-api-4375643.

Usage: gen_image_vertex.py "<prompt>" <outpath.png> [aspect] [model]
  aspect: 1:1 | 16:9 | 9:16 | 4:3 | 3:4   (default 16:9)
"""
import base64, json, os, subprocess, sys, urllib.request, urllib.error

PROJECT = os.environ.get("VERTEX_PROJECT", "openai-api-4375643")
LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
prompt = sys.argv[1]
out = sys.argv[2]
aspect = sys.argv[3] if len(sys.argv) > 3 else "16:9"
model = sys.argv[4] if len(sys.argv) > 4 else "imagen-3.0-generate-002"

token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
url = (f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
       f"/locations/{LOCATION}/publishers/google/models/{model}:predict")
body = {
    "instances": [{"prompt": prompt}],
    "parameters": {
        "sampleCount": 1,
        "aspectRatio": aspect,
        # Clinical/medical content — allow people, no watermark on the asset.
        "personGeneration": "allow_adult",
        "addWatermark": False,
        "safetySetting": "block_few",
    },
}
req = urllib.request.Request(url, data=json.dumps(body).encode(),
                             headers={"Authorization": f"Bearer {token}",
                                      "Content-Type": "application/json"}, method="POST")
try:
    r = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:800]); sys.exit(1)

preds = r.get("predictions") or []
b64 = None
for p in preds:
    b64 = p.get("bytesBase64Encoded") or p.get("image", {}).get("bytesBase64Encoded")
    if b64:
        break
if not b64:
    print("NO IMAGE. Response head:", json.dumps(r)[:900]); sys.exit(1)
open(out, "wb").write(base64.b64decode(b64))
print("SAVED", out, os.path.getsize(out), "bytes")
