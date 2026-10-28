# PR9 immutable scanner repair evidence

## Scope and provenance
Issue #1, existing PR #9 branch only. Original head `1fc8b98ac5211301620434353f2aa8e4bb9dbb8d`, base `dd135fccbfa872ddbb3d082985b2cbf14d7ef56e`. Original CI run 40736124460 succeeded **before** these fixes and is not evidence for the repaired candidate. No main merge, production change, permission grant, or credentials are included.

## Implementation verification (2026-10-28)
Local Node v24.22.1 / Git 2.52.0. Commands executed: `node --test tests/*.mjs`, `git diff --check`, `node scripts/secret-guard.mjs --staged`, and exact-commit scans. Original suite: 8/8 passed. New regressions against the original scanner: 13 failing assertions out of 27 tests. Additional annotated-tag identity, symlink CLI entry and preserve-symlinks-main cases each failed before their correction. Corrected scanner at local commit `7e28a78dfafb122f13df19d04b2b6c7f1275d5b1`: 30/30 tests passed.

Scanner SHA-256: `9a0f064a4f8e09d6b414358441bf79597c5cbb21bf605d9ab39d228344b74c0b`. This in-repository digest is informational, NOT an independent source of approval. The separate reviewer must authenticate the bytes outside candidate control, scan the final exact candidate SHA, and retain machine results. Subsequent documentation-only revisions still require exact-HEAD validation. All data in the tests is synthetic; no real secrets were requested or used.

## Pending gates and limits
Independent full final review and new exact-remote-HEAD CI are pending at this record's creation; later verified results belong in the PR review record. A separate agent is not automatically a verified different model/runtime. The candidate-controlled workflow is only a self-check. Independently enforced source/check authority and protection are not established, so autonomous-write enablement remains BLOCKED. No claim is made that all secrets, history, artifacts or unsupported encodings are detected.

Rollback: revert repair commits on the existing branch and rerun affected checks; reverting restores known bypasses and cannot be presented as a safe gate. No external state/configuration migration is required.
