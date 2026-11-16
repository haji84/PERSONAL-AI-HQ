# Local different-model advisory review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Observe two bounded, blinded synthetic critiques by a distinct official local model without granting approval authority.
**Architecture:** New optional reviewer adapter uses the existing hash-verified llama runtime and clean bounded process primitive. Host freezes fixture expectations outside prompts, verifies numeric claims deterministically and retains raw advisory observations.
**Tech Stack:** Node built-ins, Python stdlib, optional pinned SmolLM2 GGUF; no dependencies/workflows added.
**Spec:** docs/LOCAL_REVIEWER_DESIGN.md

## Global Constraints
Two calls maximum, one per fixed fixture; no retry/fallback. 2 threads, context1024, max256 tokens, wall180 seconds, aggregate output100KiB, child RLIMIT_AS4GiB through exec replacement. Numeric witness a,b in[-9,9], actual/required in[-18,18], safe integers. All verdict alternatives accessible. No expected verdict, tests, answer, label or other review leaked to model. No generated output execution or authority effects. Actual download/inference requires independent code review and parent GO.

## Review Focus
- Artifact mismatch or same builder/reviewer identity must fail before spawn.
- Fixture/oracle/expectation/wrapper mutation must invalidate both outcomes, including second-call success.
- Invalid/false/uncertain output must remain negative; model output cannot override host identity or approval fields.
- Process failures and captured prefixes must preserve completeness without fabricating full-output evidence.
- Mock seams must never become actual-model attestation; default CI starts no model.

### Task 1: Reviewer process contract
Files: scripts/local-reviewer-adapter.mjs; scripts/local-model-limit.py; tests/local-reviewer-adapter.test.mjs; tests/fixtures/local-reviewer/manifest.json.
- [ ] RED tests for profile/model independence, exact fixture inputs, blind prompt, open verdict grammar, JSON bounds/unknown fields, byte hashes and resource wrapper.
- [ ] Minimal GREEN implementation using existing bounded process and bundle verifier; wrapper limits then execs trusted command, never reviewer output.
- [ ] Focused tests green; no inference/download.

### Task 2: Deterministic advisory proof
Files: scripts/synthetic-review-proof.mjs; scripts/review-witness-check.py; tests/synthetic-review-proof.test.mjs.
- [ ] RED tests for accepted/rejected numeric witnesses, fixed input hashes, host-hidden expectation map, two-call bound, retained negative results and second skipped after infrastructure error.
- [ ] Implement strict AST arithmetic interpretation without eval; no reviewer-generated code or command execution.
- [ ] Freeze oracle/source/runtime/model/prompt/grammar identity; separate modelExecuted, formatValid, witnessValid, caseAgreement and unverified mocks.
- [ ] Full isolated suite and independent code review; preserve all failures.

### Task 3: Explicit live proof (pending separate parent GO)
- [ ] Download only exact official artifact with size cap and SHA verification; retain official license declaration. Never CI/autofallback.
- [ ] Two fresh bounded contexts or earlier documented safety stop, no answer prescriptions. Preserve complete private raw observations and sanitized public summary.
- [ ] Independent rehash/retest evidence; no release authority, no operational independent-review/24h claim.
- [ ] Sole publisher/root coordinate same-PR integration; no push/merge by this implementer.

### Task 4: Separately authorized structural recovery
- [x] Preserve initial two-call receipt: one accepted advisory and one empty-reason schema rejection; independent evidence check completed.
- [x] RED/GREEN nonempty reason grammar and whitespace rejection, selected-only terminalization, predecessor byte/hash/failure identity checks; no acceptance weakening.
- [x] Pin original receipt and unchanged positive prompt; actual wrapper selects only failed positive fixture, at most one fresh call.
- [x] Full isolated regression: 208 passed, zero failed; no model executed by tests.
- [ ] Independent code review of exact recovery hashes, then separate parent live clearance.
- [ ] One bounded cached-model recovery, or retain failure without retry; separate receipt never rewrites original pair.
- [ ] Independent evidence check and sanitized documentation before sole-publisher integration.
