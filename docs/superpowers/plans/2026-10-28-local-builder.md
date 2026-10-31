# Local synthetic builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optional model-neutral adapter with a measured seeded-failure → actual generated repair → real passing-test proof.
**Architecture:** Trusted host scopes requests; offline model returns an untrusted proposal; existing contract and narrow Python AST gate separate generation from testing. No authority or deployment integrations.
**Tech Stack:** Node built-ins, Python stdlib, optional preverified local llama.cpp/GGUF cache.
**Spec:** docs/LOCAL_BUILDER_DESIGN.md

## Global Constraints
All limits, scope, provenance checks and prohibitions in the spec apply. Default CI performs no downloads or real model run. No production implementation until independent design review resolves findings. Preserve shared worker ownership.

## Review Focus
- Hash or bundle/symlink mutation fails before spawn.
- Malicious generated AST never executes; bounded legal arithmetic remains accepted.
- Timeout/output overflow/nonzero exit/noisy or invalid JSON stays failure.
- Baseline infrastructure failure or unexpected pass cannot count as a detected code bug.
- Test mutation, disallowed path, unchanged repair, invalid base or fake receipts cannot count as completion.

### Task 1: Scoped local adapter
Files: scripts/local-builder-adapter.mjs; tests/local-builder-adapter.test.mjs; tests/fixtures/local-builder/manifest.json.
Interface: async runLocalBuilder({request,profile,artifacts}) returns validated proposal plus measured receipt; pure profile/request validators and trusted subprocess boundary testable without inference.
- [x] Add failing tests for all shape/scope/hash/env/timeout/output/process/JSON restrictions; fake process only in unit tests, explicitly labeled non-inference.
- [x] Run focused node tests and observe failures for absent implementation.
- [x] Implement minimum adapter, immutable trusted profile and cached-file validation; existing parseBuilderResponse unchanged.
- [x] Run focused tests; record evidence.

### Task 2: Narrow arithmetic test boundary and proof
Files: scripts/synthetic-python-check.py; scripts/synthetic-builder-proof.mjs; tests/synthetic-builder-proof.test.mjs; tests/fixtures/local-builder/*.
Interfaces: Python helper receives code JSON via stdin and emits measured JSON success/assertion/safety/infrastructure classification. Proof runner coordinates baseline check, model callback, scoped apply and unchanged-test retest; production manual entry uses real adapter only.
- [x] Add failing positive/negative AST and proof transition tests including baseline pass/infrastructure error, malformed proposal, mutation and model failure.
- [x] Run focused tests red; implement strict whitelist/resource bound/test harness and orchestration.
- [x] Run tests green plus whole node suite; no real inference inside CI.

### Task 3: Real measured local run and evidence
Files: docs/evidence/PR11_LOCAL_MODEL_20261028.md; manual output kept outside repo.
- [x] Recheck source/cache hashes and synthetic-only prompts; independently reviewed implementation first.
- [x] Execute explicit real cached-model proof once with documented bounds. No manufactured output/fallback; failure triggers diagnosis, not concealed retry.
- [x] Verify raw receipts/hashes/output and test transitions. Save sanitized public report distinguishing seeded baseline from model behavior and excluding machine paths/binaries.
- [ ] Parent integration and exact-revision CI remain pending; final independent code and actual-evidence review passed. No merge/activation.

### Task 4: Evidence-complete bounded recovery (independent design approval required)
- [x] Validate unified failure envelopes with process/JSON/AST/retest failure tests and completeness flags before live calls.
- [x] TDD checker canonical AST identity and source; same semantics/format variation produce same signature, wrong inputs remain rejected.
- [x] TDD current-candidate request validation and recovery controller: actual failing baseline, max two calls, repeated semantic failure stops, new candidate feeds next request, all attempts retained, injected builders remain unverified.
- [x] Independent implementation review plus full suite before any new inference.
- [x] Run at most two actual corrective calls with recovered-artifact origin explicit; persist complete success/failure receipt; no hidden fallback.

## Measured checkpoint
2026-10-28: reviewed frozen baseline70321 plus this optional slice passed140 tests; reviewer independently reran29 focused and140 full. Four earlier attempts remain documented as failures with explicit provenance gaps. Bounded candidate-informed recovery then used one actual local model call and passed six immutable arithmetic tests. Original recovered-input provenance remains incomplete. See docs/evidence/PR11_LOCAL_MODEL_20261028.md; public evidence contains no raw host logs, weights or binaries.
