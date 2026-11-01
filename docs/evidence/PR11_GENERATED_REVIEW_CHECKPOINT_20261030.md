# PR #11: generated-source review and local checkpoint verification

Date: 2026-10-30 JST.
Overall status: PARTIAL. No completed autonomous-development or independent-security approval is claimed.

## Verified code and CI
- Source commit: `1c7ec63f5a7c1d5af47402b368d1d83fac03bfb5`.
- GitHub Actions run: https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40909767204
- Job: `123574229858`, conclusion `success`.
- Actual checkout: synthetic merge `e4fcbf345bfc5ec3255511d010ec745f18f06aa9`, combining the source above with main `dd135fccbfa872ddbb3d082985b2cbf14d7ef56e`.
- Observed log totals: 240 tests, 240 pass, 0 fail, 0 skipped, 0 cancelled.
- Previous full CI at `c10864df75f6d9d957bfc543e004bae68bc09f3a`, run 40908618178, passed 239 tests before the final direct-entry HEAD guard test.
- New implementation tests were committed before their implementation; failing runs include 40907339809, 40907867285, 40908362623 and 40909506562. These are development RED runs, not model execution failures.

## Defect and repair
The prior model bridge admitted review only when a generated source hash matched a historical fixed addition specimen. This could reject a valid result containing different whitespace or parentheses before invoking the reviewer. Code inspection and old/new synthetic test paths establish this limitation. The prior live model trial did not retain enough diagnostics to prove this was its actual failure cause.

The actual cached-model bridge now takes the builder attempt's original generated source, verifies its digest, applies the existing bounded Python AST/test/witness checks, and supplies those exact bytes to the generated-source reviewer. Only formatting variants of the existing addition fixture are admitted; arbitrary programs, comments, imports and expanded arithmetic behavior remain rejected. No fixed answer is substituted for model output.

Direct actual-review entry also verifies current Git HEAD before accessing any model artifacts. The legacy fixed-specimen test seam remains separate so historical evidence is not reclassified.

## Local checkpoint and restart
A new exclusive local checkpoint binds exact generated source, source/prompt-source hashes, review metadata, test identity and Git HEAD. Its file is mode 0600, fsynced, size bounded and opened without following a final-component symlink. Duplicate saves, changed source, wrong expected digest, wrong HEAD and unapproved raw-output fields are rejected.

The state controller binds checkpoint digest to the attempt/result and state event. A new OS process in the SAME test runner verifies the saved checkpoint without another model call. Even a previously BLOCKED job rejects a corrupted checkpoint. A shared exclusive local lock prevents concurrent invocations from launching the same attempt twice; stale locks stop for explicit recovery rather than silently launching more inference.

This is local file integrity and process-restart evidence, NOT encryption, independent authentication, hardware power-loss durability, or persistent state across separate hosted Actions runs. The temporary model-probe script still cleans up its scratch state; it is not a remote checkpoint service.

## Evidence classes and unchanged gates
- CI model responses are injected test doubles. Actual Python arithmetic checks and OS subprocess/file/concurrency operations ran; NO fresh Qwen or SmolLM2 inference ran in this CI.
- The live Qwen -> exact-source SmolLM2 path is wired but its new live execution and accepted response remain UNVERIFIED.
- Stored bounded review metadata is not a formal independent review, nor a full durable archive of raw model receipts.
- `authority=none`, release permission false and no next-task dispatch are retained. Fake/injected callbacks cannot claim observed model execution.
- Existing workflow-inventory and permission tests pass unchanged. No model workflow was activated, no workflow/security-policy exception added, no external checkpoint store provisioned, no main merge or paid service enabled in this change.
- PR #9 has no submitted GitHub reviews at the latest check. Its formal independent safety gate remains pending.

## Unmet acceptance
1. Independent review of the revised execution path and the PR #9 safety boundary.
2. Explicitly authorized, bounded live Qwen/SmolLM2 run with exact candidate and response evidence retained.
3. An approved authenticated checkpoint transfer that survives runner disposal.
4. A distinct GitHub Actions run consuming that exact checkpoint and automatically advancing the permitted next stage, with stale/duplicate/corrupt inputs rejected.

Do not convert the 240-test CI success into a full autonomous-loop PASS.
