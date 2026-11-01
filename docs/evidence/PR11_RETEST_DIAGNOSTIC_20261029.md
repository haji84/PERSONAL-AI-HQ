# Offline retest diagnostic projection

Issue #10 recovery subgoal; local baseline `a2e32199260354565bb68cf7ab28aee338a732fd`. This change adds an unwired, pure diagnostic projector and synthetic tests. It does not revive the consumed one-shot helper or diagnose the historical model response.

## Observed evidence loss
The historical helper at `fce60149a1602e48efdfd56d37a3fbd4e4f58bcb` omitted `attempt.retest.status` and substituted `0` for missing `caseCount`. The existing trusted arithmetic checker reports `caseCount` only on PASS. Two offline synthetic checker probes returned distinct ASSERTION_FAILURE and SAFETY_REJECTED results, both without a count, demonstrating that the old summary collapsed distinct failures into the same zero value. This does not identify which failure happened in run 40916992079; the actual candidate remains unavailable beyond its digest.

## Additive contract
`projectRetestDiagnostic(attempt)` returns exactly three frozen fields: observed own-property presence, a fixed reported status enum (or UNKNOWN), and a reported safe integer 0–6 (or null). Neither PASS nor a number grants acceptance or proves executed cases. Own accessors are not invoked; inherited properties are ignored; reflection exceptions cannot leak arbitrary error text. Known outer presence survives nested reflection failures. Inputs are assumed inert records: Proxy traps can execute during reflection, so this is not a sandbox or a time bound for hostile code.

No source, failure string, prompt, raw model response, credential or arbitrary error is projected. The module performs no IO and is not connected to any runner, workflow, state controller or authority gate.

## Verification
- RED: the new focused test file failed with ERR_MODULE_NOT_FOUND before implementation.
- GREEN: 269 tests passed, zero failures/skips (261 existing plus 8 new), on local Node 24.22.1. No model was launched.
- Independent code review reran all 269 tests and nine additional boundary probes, with no blocking finding. This is not formal GitHub approval or a product security gate.
- Source SHA-256: `7fc5ff3b099da945c840b595273200956208810039085d3d68f42b56eac0bc98`.
- Tests SHA-256: `42a5a54c3812b31022ebdd4166cc346815d4f9fe9957a4543844fb72a020344d`.
- CI for the eventual published revision remains pending at this checkpoint; prior green CI is not substituted for it.

Existing runtime code, checks, workflow inventory, policy and recorded history are unchanged. Any later integration needs its own bounded design and verification. No new inference, OIDC activation, remote persistence, permission change or main integration is authorized by this local diagnostic addition.
