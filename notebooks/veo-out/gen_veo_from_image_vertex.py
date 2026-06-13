#!/usr/bin/env python3
"""Image-to-video via Vertex AI Veo (gcloud auth, project openai-api-4375643).
Vertex uses :predictLongRunning to start and :fetchPredictOperation to poll
(returns the video inline as base64 when no storageUri is given).

Usage: gen_veo_from_image_vertex.py <image.png> "<motion prompt>" <out.mp4> [aspect] [model]
  aspect: 16:9 | 9:16   (default 16:9)
"""
import base64, json, mimetypes, os, subprocess, sys, time, urllib.request, urllib.error

PROJECT = os.environ.get("VERTEX_PROJECT", "openai-api-4375643")
LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
image_path = sys.argv[1]
prompt = sys.argv[2]
outpath = sys.argv[3]
aspect = sys.argv[4] if len(sys.argv) > 4 else "16:9"
model = sys.argv[5] if len(sys.argv) > 5 else "veo-3.1-fast-generate-001"

token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
mime = mimetypes.guess_type(image_path)[0] or "image/png"
img_b64 = base64.standard_b64encode(open(image_path, "rb").read()).decode()
base = (f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{LOCATION}/publishers/google/models/{model}")
hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=hdrs, method="POST")
    return json.load(urllib.request.urlopen(req))

body = {
    "instances": [{"prompt": prompt, "image": {"bytesBase64Encoded": img_b64, "mimeType": mime}}],
    "parameters": {"aspectRatio": aspect, "sampleCount": 1, "durationSeconds": 6, "generateAudio": False},
}
try:
    op = post(f"{base}:predictLongRunning", body)
except urllib.error.HTTPError as e:
    print("START HTTP", e.code, e.read().decode()[:1000]); sys.exit(1)
name = op.get("name")
print("operation:", name, flush=True)
if not name:
    print("FAILED start:", json.dumps(op)[:800]); sys.exit(1)

resp = None
for i in range(60):
    time.sleep(15)
    try:
        d = post(f"{base}:fetchPredictOperation", {"operationName": name})
    except urllib.error.HTTPError as e:
        print("POLL HTTP", e.code, e.read().decode()[:400]); sys.exit(1)
    if d.get("done"):
        resp = d
        print(f"done after ~{(i+1)*15}s", flush=True)
        break
    print(f"poll {i+1}: generating…", flush=True)
if not resp:
    print("TIMEOUT"); sys.exit(1)
if "error" in resp:
    print("GEN ERROR:", json.dumps(resp["error"])[:900]); sys.exit(1)

def find_b64(o):
    if isinstance(o, dict):
        for k in ("bytesBase64Encoded", "videoBytes"):
            if isinstance(o.get(k), str):
                return o[k]
        for v in o.values():
            r = find_b64(v)
            if r: return r
    elif isinstance(o, list):
        for v in o:
            r = find_b64(v)
            if r: return r
    return None

def find_uri(o):
    if isinstance(o, dict):
        u = o.get("gcsUri") or o.get("uri")
        if isinstance(u, str): return u
        for v in o.values():
            r = find_uri(v)
            if r: return r
    elif isinstance(o, list):
        for v in o:
            r = find_uri(v)
            if r: return r
    return None

payload = resp.get("response", resp)
b64 = find_b64(payload)
if b64:
    open(outpath, "wb").write(base64.b64decode(b64))
    print(f"SAVED: {outpath} ({os.path.getsize(outpath)} bytes)")
else:
    uri = find_uri(payload)
    print("NO inline video. uri:", uri, "| head:", json.dumps(payload)[:800]); sys.exit(1)
