# PR #11: bounded retest diagnostics, no model rerun (2026-10-30)

Status: **DIAGNOSTIC CODE/CI VERIFIED; AUTONOMOUS CYCLE STILL BLOCKED**. This is a measured code change, not a new Qwen or SmolLM2 inference.

## Observed problem
The previous approved one-shot run [40916992079](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40916992079) observed a genuine Qwen response, then failed at `retest`. It reported only the stage, a source hash and a misleading fallback `retestCases: 0`; there was no public, safely classified `retest.status` in the summary. The exact rejection cause of that historical response **cannot be reconstructed from the retained public evidence**. SmolLM2 was not invoked. The previous one-time execution authorization was consumed.

The checker already emitted `SAFETY_REJECTED` or `ASSERTION_FAILURE`, but `summarizeRecovery` in `model-cycle-bridge.mjs` discarded these structured statuses, and `model-cycle-state.mjs` did not store them.

## Test-first changes and evidence
- New failures reproduced before implementation: RED CI [40977859972](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40977859972) (3 diagnostic tests), [40978090307](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40978090307) (bridge), [40978294372](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40978294372) (persistence).
- Added pure bounded `summarizeRetestDiagnostic`. A verified fixed-case assertion mismatch is reported as `ASSERTION_FAILURE` and `case-1` through `case-6`. Other assertion text is not copied. `SAFETY_REJECTED`, `UNVERIFIED`, and `NOT_RETEST` remain distinct; an absent case count stays **null, never zero**.
- The existing Python AST checker emits only one of seven fixed rejection reasons: `SOURCE_BOUNDS`, `SYNTAX_ERROR`, `STRUCTURAL_LIMIT`, `FUNCTION_SHAPE`, `ARGUMENT_SHAPE`, `EXPRESSION_NOT_ALLOWED`, or `INPUT_FORMAT`. It never returns rejected code, exception messages or arbitrary dynamic text. Its arithmetic whitelist and six immutable acceptance cases are unchanged.
- The bridge forwards only these bounded fields; the state controller persists them with an independent allowlist, rejects untrusted diagnostics and preserves records across local restart. The optional `run-local-model-probe.mjs` reporter prints fixed status, case ID and rejection enum from the sanitized saved receipt for a **future separately authorized probe only**.
- RED safety reason tests [40978566157](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40978566157) failed before the checker change; a malformed test fixture was corrected to include a real newline, not a literal backslash-n. RED propagation tests [40979000014](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40979000014) failed before the final allowlist bridge.
- Final verified HEAD before this documentation: `c276892fa71ea23e2e406a9a61e76055ff429c8b`. CI [40979270553](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40979270553) **278/278 PASS, 0 failed, 0 skipped**. Tests include real Python checker subprocesses, synthetic builder failures, bridge stop without invoking the reviewer, and durable local restart.

## Limitations and approval boundary
- No Qwen/SmolLM2 model invoked, downloaded or reattempted in this change; synthetic-only tests cannot establish actual inference or a genuine independent review.
- The historical one-shot remains **FAIL/BLOCKED**, with exact historical rejection reason unknown.
- Local checkpoint persistence is not remote, authenticated cross-Actions durability. No dedicated remote store, new secrets/OIDC permissions, new workflow, or separate Actions resume is active.
- PR #9 still requires independently authenticated security review; PR #11 remains Draft. No merge to main, publication, paid services, privilege changes, or owner GPS data were involved.
- Next real-model attempt requires a **new explicit bounded owner approval**, and must preserve immutable tests, identity of the actual Qwen-generated source and reviewer, and the diagnostic source SHA without raw output in public logs.
