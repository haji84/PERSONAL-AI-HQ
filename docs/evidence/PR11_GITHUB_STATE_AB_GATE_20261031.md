# Cloudflare-independent A→B continuation gate (2026-10-31)

Status: LOCAL SYNTHETIC PROOF ONLY. Remote GitHub Actions A→B E2E NOT VERIFIED. No release authorization.

## Objective
Preserve the existing PR #11, use a separate private GitHub state repository as a candidate durable store, and demonstrate two distinct Actions runs with authenticated, atomic, fenced state transitions. No new PR, main merge, paid activation, credential expansion, or public disclosure is authorized by this document.

## Local bounded evidence
A separate local Python SQLite synthetic fixture was run with independent subprocesses. PASS: A writes, B resumes, stale A is rejected, second B is rejected, tampered digest is rejected, expired checkpoint is rejected, and two simultaneous B processes yield exactly one successful resume. This is **not** proof of GitHub cross-run authentication, secure storage, or an implementation of PR #11's JS state contract. The fixture uses a static synthetic source and no private data.

## Required remote design review before activation
1. Decide the dedicated private state repository and verify it is private. Never place user data, credentials, raw model output, or private GPS in public Actions logs or artifacts.
2. Verify short-lived per-run authentication with minimal repository-scoped permissions. A GitHub Actions OIDC identity by itself is not a GitHub repository write credential; the trusted credential exchange/authorization path must be independently verified.
3. Implement Git ref update with compare-and-swap using the expected prior ref SHA and immutable commit history, or another independently verified atomic backend. A simple read/edit/contents API sequence and GitHub Actions concurrency are **not** sufficient evidence of exclusivity.
4. Bind each transition to repository, goal, job, run ID, run attempt, revision, epoch, lease holder, server-trusted expiry, and evidence SHA. Require idempotency and reject replay, stale writer, tampering, and duplicate next-task dispatch.
5. For lease expiry, use a trusted clock and enforce fencing at commit time. A client-supplied timestamp must never be the sole expiry authority.
6. Review PR #9 security gate independently before any integration. No automatic merge or authority expansion.

## E2E acceptance
- Actions A writes only a synthetic checkpoint and returns a durable commit/ref identifier and SHA.
- Separate Actions B authenticates independently, reads the exact A checkpoint, verifies SHA and revision, atomically claims a new epoch, and advances one synthetic task.
- A stale A commit, concurrent B, expired lease, wrong run identity, tampered state, duplicate dispatch and unauthorized reader/writer all fail closed with durable sanitized evidence.
- Tests and independently reviewed source must match the exact head SHA. Run A and B IDs, timestamps, bounded receipts, immutable state refs and CI outcomes must be retained.
- Remain BLOCKED until real cross-Actions execution is observed and independent security review is accepted.
