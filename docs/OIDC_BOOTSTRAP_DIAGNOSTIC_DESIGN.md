# Local-only diagnostic successor design

Status: independent design and actual-code review found no blocker for the inactive v2 source draft. Final source pin and lifecycle artifacts below also passed independent narrow review as an inactive package. No activation approval. The consumed v1 run is not rerun. No active workflow, permissions, mint, state endpoint or Cloudflare resource action is proposed.

## Proven evidence and limit

Run 40768550319 / job 123099195190 was first run/attempt, correct branch. Checkout, exact Node 22.23.4 and dependency installation succeeded. Sanitized logs confirm source/checkout commit 8342cbc and check-run identity. The verifier emitted only OIDC_BOOTSTRAP_FAILED within the same recorded second. Actual runner context, endpoint, JWT shape, attempted issuance and failure stage remain unknown.

GitHub-owned archived actions-oidc-debugger README (read 2026-10-28, sample timestamps from 2025-07-03) shows an ordinary-job example with job_workflow_ref/job_workflow_sha and 21600-second exp-iat. Its workflow does not use a reusable job. Current GitHub OIDC reference describes these claims as reusable-workflow claims. This motivates synthetic tests only: it neither proves the current provider behavior nor this run's token shape. No trust/lifetime check may be loosened from this sample.

Sources: [archived GitHub example](https://raw.githubusercontent.com/github/actions-oidc-debugger/main/README.md), [its ordinary workflow](https://raw.githubusercontent.com/github/actions-oidc-debugger/main/.github/workflows/action-test.yml), [current GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

## Isolation and interfaces

Owned files are `scripts/oidc-bootstrap-diagnostic.mjs`, `tests/oidc-bootstrap-diagnostic.test.mjs`, `templates/oidc-bootstrap-v2.yml.example` and this document. The final pinned-template/lifecycle contract is a subsequent local preparation step after the source commit exists. Keep the consumed v1 verifier, template, lifecycle patches and existing tests byte-identical. The old template checks out an immutable historical verifier and its tests deliberately bind that hash; mutating v1 would confuse its evidence contract.

The successor copies the reviewed verifier's bounded validation/transport logic with diagnostic annotations, except for the exact v2 workflow identity and reserved v2 audience approved below. First-run/first-attempt gates and every other acceptance check remain unchanged. The new template remains inactive. Source-stage tests rejected its initial placeholder; the pinning stage binds the actual reviewed source commit below.

Export `runBootstrapDiagnostic(context, dependencies)` returning either `{ok:true, proof}` or `{ok:false, stage, field}`. `proof` retains exactly the eleven existing validated public keys. Importing never requests credentials. CLI requires the same explicit one-shot flag and GitHub context; it emits only the old success JSON or `OIDC_BOOTSTRAP_FAILED stage=<fixed> field=<fixed>` and exits nonzero. No field values, arbitrary names, error text, token, request URL, headers or credentials may enter a diagnostic. Failure output is one bounded fixed-enum line; success output remains the eleven-key proof only. The pure `classifyVerificationFailure(error)` test seam never reads/returns payload, token, message, stack or cause properties; errors may contain them. It cannot change acceptance.

## Fixed enums and failure boundaries

Stages, all compile-time literals: ENTRYPOINT, CONTEXT, DEPENDENCY, CLOCK, MINT_CONFIGURATION, MINT_TRANSPORT, TOKEN_FORMAT, JWKS_TRANSPORT, JWKS_FORMAT, JWT_VERIFICATION, SIGNATURE, REGISTERED_CLAIMS, CLAIM_IDENTITY, CLAIM_SUBJECT, CLAIM_OPTIONAL, CLAIM_TIME.

Fields come from a compile-time allowlist only: NONE; ARGS; EVENT_FILE; GITHUB_ACTIONS; GITHUB_SERVER_URL; GITHUB_EVENT_NAME; GITHUB_REPOSITORY; GITHUB_REPOSITORY_ID; GITHUB_REPOSITORY_OWNER_ID; GITHUB_REF; GITHUB_HEAD_REF; GITHUB_BASE_REF; GITHUB_RUN_NUMBER; GITHUB_RUN_ATTEMPT; GITHUB_RUN_ID; GITHUB_WORKFLOW_REF; GITHUB_WORKFLOW_SHA; GITHUB_SHA; RUNNER_ENVIRONMENT; RUNNER_OS; HQ_BOOTSTRAP_SOURCE_SHA; HQ_BOOTSTRAP_CHECKOUT_SHA; HQ_BOOTSTRAP_CHECK_RUN_ID; EVENT_FIELDS; REQUEST_URL; REQUEST_CREDENTIAL; iss; aud; repository; repository_id; repository_owner_id; repository_visibility; event_name; head_ref; base_ref; ref; workflow_ref; workflow_sha; run_id; run_number; run_attempt; check_run_id; sub; environment; job_workflow_ref; job_workflow_sha; iat; nbf; exp; LIFETIME; TOKEN_AGE.

Use a private branded failure helper validating stage/field membership before constructing a result. Unexpected exceptions return only current stage/NONE. Never enumerate payload/environment keys to construct diagnostics. Literal expected-context and literal expected-claim maps may provide allowlisted field names; never report actual values.

Keep the existing jose jwtVerify operation (no crypto refactor). A caught official jose `JWSSignatureVerificationFailed` may map to SIGNATURE/NONE. Official JWTExpired/JWTClaimValidationFailed may map to REGISTERED_CLAIMS with only an exact allowlisted field from the literal requiredClaims plus iss/aud; registered claims use REGISTERED_CLAIMS and custom required fields use JWT_VERIFICATION. Unknown/throwing claim getters yield NONE. Do not print/read exception message, stack, payload or arbitrary error fields; unknown errors remain JWT_VERIFICATION/NONE. This classification identifies failure class, not a signature claim about failed/unverified tokens.

MINT_TRANSPORT means the single request function was entered, not proof of token issuance. TOKEN_FORMAT means a bounded JSON envelope was returned, not proof that a valid token was issued. Final claim stages occur only after jose verification. Diagnostics report the first detected failure only; later checks may not have run, so the code is not an exhaustive list of every mismatch. Diagnostics cannot retrospectively identify the consumed v1 failure and cannot justify a retry.

## Required invariants/tests

All existing identity/subject/optional-claim/lifetime/audience/signature/key/source/runner/context checks remain; default failures still deny. Invalid public context cannot read credential getters. One mint and one fixed JWKS GET maximum; no retries, redirects, token-controlled URLs or fallback. Existing timeouts/byte/key limits and final completion-time checks remain.

TDD: every stage and fixed field mapping; exact success schema; malicious error strings/properties/private values never emitted; unknown exceptions map to NONE; invalid context zero credential reads/fetches; uncertain mint failure never retries; incorrect signature differs from final policy rejection; provider-shaped synthetic optional claims and 6-hour lifetime fail with fixed relevant categories, not acceptance. Output tests assert membership/booleans rather than printing token-containing assertion operands.

Before publication: independent design and actual-code review, source diff proving checks not weakened, synthetic focused/full tests, no active file/permission changes, preservation of all v1 hashes. Publisher remains sole writer to PR11. No live diagnostic run under the already consumed one-shot approval.

## Context-only alternative

A new no-OIDC workflow could inspect its own fixed public field presence, but would have a different workflow/ref/SHA/run/counter and could not reconstruct the original job's event file or environment reliably. It would not distinguish mint/signature/final-policy failure. Existing public metadata and local synthetic reconstruction are preferable to another workflow for this limited question; no context-only workflow is proposed for execution.

## Approved local v2 preparation amendment

The parent authorizes a new unique fixed workflow path `.github/workflows/hq-oidc-bootstrap-pr11-v2.yml`, with the same PR/repository/branch rules, run_number=1 and run_attempt=1. The successor will use that exact workflow-ref literal and fixed reserved audience `urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v2`; no generic trust configuration is introduced. Canonical-context differential tests compare v1/v2 acceptance and all proof fields except the explicitly reviewed workflow identity; cross-version inputs must fail.

Source is reviewed/published first, then an inactive v2 template is pinned to that actual commit and matching lock; no invented source SHA. Future activation and cleanup test patches are inert artifacts. Current tests and active workflow inventory remain unchanged during preparation.

The v1 cleanup regression currently requires exactly one read-only workflow. The parent explicitly authorizes preparation (not application) of a bounded v2 activation patch touching both tests: v1 remains absent, and inventory is exactly the unchanged read-only workflow plus byte-exact reviewed v2. The diagnostic test independently binds that same v2. Cleanup removes v2 and restores the v1 test byte-for-byte to `69a8c65505d3f1d52ab6de7ffa6be5557419f6ce2308d208e3c1ac25722f9c11`, and the diagnostic test to its reviewed inactive form. Reviewer must verify both patch pre/postimages, symlink/extra-path/hash rejection and unchanged historical v1 artifacts.

Separate exact user approval is still required for any real v2 permission/mint and cleanup. The consumed v1 run is not retried.

## Local implementation evidence

The missing-module and missing-required-claim diagnostics were observed failing before implementation/fix; the exact v2 context regression also failed before changing the two fixed identity literals. Synthetic tests cover hostile unknown/proxy errors, private property getters, malformed/uncertain responses, signature versus final policy failures, no credential access on invalid context, body timeout/no retry, immutable inputs and bounded CLI output. Canonical v1/v2 fixtures compare acceptance and exact proofs after the sole reviewed workflow-ref normalization; cross-version inputs are rejected. Archived ordinary-job/long-lifetime example shapes remain rejected.

The v2 source draft deliberately used `REQUIRES_REVIEWED_V2_SOURCE_COMMIT`; synthetic tests continue to prove that placeholder denies before runtime credential access. The later pinned template is still inactive and not authorized for execution. Historical v1 source/template/patch files are not edited. No actual failure stage or issuance fact has been recovered from the v1 generic log.

Independent actual-source review inspected the complete v1-to-successor diff and reran the exact public baseline `0f0dc1f31432ff36e3e1f6d43295fe2b363fcbcd` plus only these four new files: **189/189 tests, zero skips**, including 18 diagnostic tests. The fixed v2 workflow/audience are the only acceptance-identity changes. This is local source evidence, not a successful live proof or retrospective diagnosis of v1.

## Verified source pin and ordinary CI

Source commit `d92d452f6a3beb0f9ae10c1ac7d1083720f86308` passed [ordinary CI 40771462026](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40771462026) on Node 22.23.4: 189 passed, zero failures/skips, no active bootstrap permission. A fresh public GitHub fetch verified this commit contains diagnostic source SHA-256 `b5ec2cae53940b151d82e0e273fc5a4f24d8f02445364427d18c241d1d8dff4c`, lock `e916fdf8a7cb83062ec8a11b30cd6bc45ddde4df59c4fa79628894ec6be987eb` and manifest `3a4614679461b159207434356aa5c71a9940186f6b2371b707eca83d6b48268e`, equal to the reviewed bytes.

The inactive pinned template SHA-256 is `22d8d1a19f11714d3dc89295348b18ee41c299c658b22c945340b9a5bc95f490`. Both source-pin occurrences use that actual commit. See `docs/OIDC_BOOTSTRAP_V2_ACTIVATION_CONTRACT.md` for exact future activation/cleanup test transitions and the separate authorization gate; no patch is applied during preparation.

The final pin/lifecycle review independently reran 189/189 tests (zero skips), checked d92d Git-object hashes and both template pins, reconstructed both two-file patches in memory, verified exact active/cleanup postimages and syntax, and passed 16 lifecycle probes. Current v1 files were unchanged and both active paths absent. This qualifies the inert preparation only; separate exact user approval and fresh history/head/CI checks remain required.
