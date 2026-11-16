# One-shot OIDC bootstrap: failed verification, verified cleanup

## Exact source and scope
Activation commit `8025c2bb4806a79ef181f34afac0bd830718ddb8` changed only the reviewed workflow copy and activation test patch. Its direct parent was `fea84d3b5e7ebfcd2214dcda6ee64f9965d21e65`. The active workflow matched template SHA-256 `8d9f705e240e05b7bc13beb4a9a022d0fdd13c33b35d4fbcfa3ac3bd1778b4e4`; verifier checkout was pinned to `8342cbc80f72d2240aaa4bdc6058e78733027f20`.

An independent agent reviewed the exact runtime contract and unused workflow history before activation. Local Node 24.22.1 tests passed 171/171; limited heuristic scanning and diff checks passed. These are not a formal GitHub approval or an integrated independent reviewer receipt.

## Observed attempt
[Bootstrap run 40768550319](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40768550319), job `123099195190`, ran with run number 1 and attempt 1. It completed **failure**; run updated_at was `2026-10-28T21:02:38Z`. Checkout, exact Node 22.23.4 and production dependency installation succeeded. Source and checkout IDs matched the pinned verifier, and the injected check-run ID matched the job.

The verifier emitted only `OIDC_BOOTSTRAP_FAILED`, then exited 1. There was no validated public identity receipt. The precise failing validation stage and whether token issuance occurred are not established by this generic output. No token, raw claims, runtime credential or request URL is included here. No retry or second run was requested. Ordinary read-only CI for the activation revision also succeeded in run `40768550174`.

## Mandatory cleanup
Cleanup commit `664fff703c90770a888b9321e5afc0f456b2b4be`, direct child of activation, removed the temporary workflow and applied the reviewed cleanup test patch. Its tree is `1bc4ba36765c9ec8deb9eae6853605f016f7cd2b`; cleanup test SHA-256 is `69a8c65505d3f1d52ab6de7ffa6be5557419f6ce2308d208e3c1ac25722f9c11`. Exact remote bytes were read back. The active workflow inventory contains only the pre-existing read-only planning workflow, with no `id-token` permission.

[Cleanup CI 40768712184](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40768712184), job `123099761714`, completed success: Node 22.23.4, 171 passed, 0 failed, 0 skipped. It tested synthetic merge `b6ee0fe25e0c37cef2a04bc8b112207d6af7e1c7` of cleanup source into unchanged main `dd135fccbfa872ddbb3d082985b2cbf14d7ef56e`. This evidence describes that source, not a later documentation commit.

Workflow removal is not token revocation. The state service remains unwired/default-deny and rejects the bootstrap audience namespace. No Cloudflare provisioning, remote schema, main integration or autonomous write activation occurred. A further live attempt requires a separately reviewed and authorized scope; the failed attempt does not prove live authentication or cross-Actions persistence.
