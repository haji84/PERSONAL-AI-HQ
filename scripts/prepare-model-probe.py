#!/usr/bin/env python3
"""Prepare only SHA-pinned public synthetic probe artifacts in ephemeral CI scratch."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
builder = json.loads((ROOT / "tests/fixtures/local-builder/manifest.json").read_text())
reviewer = json.loads((ROOT / "tests/fixtures/local-reviewer/manifest.json").read_text())
sources = {
    "runtime": {
        "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11968/llama-b11968-bin-ubuntu-x64.tar.gz",
        "sha256": builder["runtime"]["archiveSha256"],
    },
    "builder": {
        "url": "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        "sha256": builder["model"]["sha256"],
        "size": 491400064,
    },
    "reviewer": {
        "url": "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/2d4a76a30b4af41ecd395c35725ac11688d4cfe4/smollm2-1.7b-instruct-q4_k_m.gguf",
        "sha256": reviewer["sha256"],
        "size": reviewer["size"],
    },
}
def sha256file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
def fetch(key, root):
    item = sources[key]
    dest = root / (key + (".tar.gz" if key == "runtime" else ".gguf"))
    max_bytes = (400 * 1024 * 1024) if key == "runtime" else item["size"]
    request = urllib.request.Request(item["url"], headers={"User-Agent": "HABU-public-synthetic-probe/1"})
    size = 0
    with urllib.request.urlopen(request, timeout=45) as response, dest.open("xb") as out:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ValueError("artifact exceeds bounded download size")
            out.write(chunk)
    if "size" in item and size != item["size"]:
        raise ValueError("artifact size mismatch")
    if sha256file(dest) != item["sha256"]:
        raise ValueError("artifact digest mismatch")
    return dest
def extract_runtime(archive, root):
    dest = root / "runtime"
    dest.mkdir(mode=0o700)
    expected = builder["runtime"]["files"]
    found = set()
    # Do not trust TAR paths, modes or symlinks even after SHA verification.
    with tarfile.open(archive, "r:gz") as bundle:
        for entry in bundle:
            basename = PurePosixPath(entry.name).name
            if basename not in expected or "sha256" not in expected[basename] or not entry.isfile():
                continue
            if basename in found:
                continue
            source = bundle.extractfile(entry)
            if source is None:
                continue
            candidate = dest / basename
            digest = hashlib.sha256()
            with source, candidate.open("xb") as out:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != expected[basename]["sha256"]:
                candidate.unlink()
                continue
            found.add(basename)
    required = {name for name, spec in expected.items() if "sha256" in spec}
    if found != required:
        raise ValueError("pinned runtime files missing")
    for name, spec in expected.items():
        if "link" in spec:
            if spec["link"] not in expected:
                raise ValueError("unapproved runtime link")
            (dest / name).symlink_to(spec["link"])
        else:
            (dest / name).chmod(0o755 if name in {"llama-completion", "llama"} else 0o644)
    return dest
def main(args):
    if args == ["--manifest"]:
        print(json.dumps(sources, sort_keys=True))
        return 0
    if args != ["--prepare"] or not os.getenv("GITHUB_OUTPUT"):
        raise ValueError("unsupported invocation")
    root = Path(tempfile.mkdtemp(prefix="hq-pinned-model-", dir=os.environ.get("RUNNER_TEMP", "/tmp")))
    runtime = fetch("runtime", root)
    runtime_dir = extract_runtime(runtime, root)
    builder_file = fetch("builder", root)
    reviewer_file = fetch("reviewer", root)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf8") as out:
        for name, value in (("runtime_dir", runtime_dir), ("builder_file", builder_file), ("reviewer_file", reviewer_file)):
            print(f"{name}={value}", file=out)
    print("PINNED_PUBLIC_ARTIFACTS_VERIFIED")
    return 0
if __name__ == "__main__":
    stage = "prepare"
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print("MODEL_PROBE_SAFE_STOP: " + stage, file=sys.stderr)
        raise SystemExit(2)
