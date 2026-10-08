"""JSONL bridge to the configured, trusted Clef release (not a model simulator)."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

# Preserve a private protocol descriptor; Python and native load/inference logs
# on stdout now go to drained stderr, never into the JSONL channel.
protocol = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
root = Path(sys.argv[1]).resolve()
model = processor = None
backend = None


def image(value):
    from PIL import Image
    payload = value.split(",", 1)[1]
    with Image.open(io.BytesIO(base64.b64decode(payload, validate=True))) as media:
        if getattr(media, "is_animated", False):
            raise ValueError("animated images are unsupported")
        return media.convert("RGB")


for line in sys.stdin:
    correlation = None
    stage = "request"
    try:
        envelope = json.loads(line)
        correlation = envelope["id"]
        request = envelope["request"]
        if backend is None:
            stage = "load"
            sys.path.insert(0, str(root))
            spec = importlib.util.spec_from_file_location("joint_schema_model", root / "joint_schema_model.py")
            backend = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = backend
            spec.loader.exec_module(backend)
            model, processor = backend.load_release_model(str(root))
        stage = "media"
        if "images" in request:
            request["images"] = [image(value) for value in request["images"]]
        if "videos" in request:
            request["videos"] = [[image(value) for value in frames] for frames in request["videos"]]
        stage = "inference"
        response = backend.systemone(model, processor, request)
        stage = "response"
        protocol.write(json.dumps({"id": correlation, "response": response}, allow_nan=False) + "\n")
    except Exception:
        # Do not expose request contents, arbitrary traceback text or local paths.
        protocol.write(json.dumps({"id": correlation, "error": stage}) + "\n")
