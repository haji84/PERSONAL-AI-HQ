#!/usr/bin/env python3
"""Single-use owner-approved read-only model download. No private source or cloud state."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SHA = "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046"
REVISION = "2ab9f8f42af02fc212effaef7c4850c885e965f4"
URL = ("https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/"
       "resolve/" + REVISION + "/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf")
LIMIT = 1250000000

def main():
    if sys.argv != [sys.argv[0], "--prepare"] or not os.environ.get("GITHUB_OUTPUT"):
        raise ValueError("Missing owner-approved one-use invocation")
    spec = importlib.util.spec_from_file_location("existing_pinned_public_assets",
       ROOT / "scripts" / "prepare-model-probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = Path(tempfile.mkdtemp(prefix="hq-approved-15b-",dir=os.getenv("RUNNER_TEMP","/tmp")))
    runtime_archive = module.fetch("runtime", root)
    runtime_dir = module.extract_runtime(runtime_archive, root)
    reviewer_model = module.fetch("reviewer", root)
    # Always verify model content as a stream. Never derive trust from an HTTP header.
    candidate = root / "qwen15.gguf"
    got = hashlib.sha256()
    length = 0
    req = urllib.request.Request(URL, headers={"User-Agent":"PERSONAL-AI-HQ-public-synthetic-once"})
    with urllib.request.urlopen(req, timeout=90) as remote, candidate.open("xb") as out:
        while part := remote.read(1024 * 1024):
            length += len(part)
            if length > LIMIT:
                raise ValueError("Model exceeds approved upper byte bound")
            got.update(part)
            out.write(part)
    if got.hexdigest()!=SHA or length<1000000000:
        raise ValueError("Pinned Qwen1.5B byte integrity mismatch")
    # Bound the scope and output to local ephemeral paths; never upload binary artifacts.
    with open(os.environ["GITHUB_OUTPUT"],"a",encoding="utf8") as dest:
        for name,value in (("runtime_dir",runtime_dir),
                           ("reviewer_file",reviewer_model),
                           ("builder_file",candidate)):
            print(name+"="+str(value),file=dest)
    print("APPROVED_ONCE_PINNED_QWEN15_AND_SMOLLM2_ARTIFACTS_VERIFIED")
    print("QWEN15_SHA256="+SHA)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("APPROVED_MODEL_PREPARE_SAFE_STOP",file=sys.stderr)
        raise SystemExit(2)
