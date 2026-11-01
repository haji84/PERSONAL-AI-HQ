# Inactive PR11 OIDC bootstrap implementation plan

> Independent design review accepted local TDD with the two-stage source-pin sequence. No active workflow, token mint, permission change, or resource action at any local implementation stage.

**Spec:** `docs/OIDC_BOOTSTRAP_DESIGN.md`.
**Goal:** Prepare an inactive one-shot proof template and synthetic-tested strict public projection of verified GitHub OIDC identity.
**Architecture:** One native bounded runtime mint fetch, one fixed JWKS fetch, pinned jose, strict signed/context validation, newly constructed public-only output. A reserved audience is hard-denied by state auth.

## Owned files and interfaces

- `templates/oidc-bootstrap.yml.example`: non-active YAML with unique eventual path, PR11/same-repo/fixed-branch/first-run/first-attempt guards and pinned official actions/source; no actual permission activation.
- `scripts/oidc-bootstrap-proof.mjs`: exported `runBootstrapProof(context, dependencies)` returns only a whitelist proof object or generic failure; native CLI runs only with the literal one-shot flag. Context and I/O are dependency-injected only for synthetic local tests, not selected by request input.
- `tests/oidc-bootstrap-proof.test.mjs`: synthetic ephemeral signing, stub transport, exact output and template safety contract.
- Small isolated edits to `scripts/hq-oidc-auth.mjs` / `tests/hq-oidc-auth.test.mjs`: deny `urn:personal-ai-hq:oidc-bootstrap:` configuration before fetch. Coordinate ownership before touching these files.

## Review focus

- Invalid/missing GitHub context, counters, PR or branch: no token request at all.
- First mint succeeds but response/verification fails: no retries or token/exception logging.
- Unknown custom subject/private metadata: generic failure, never discovery-by-dumping.
- Mutable action/source/dependency reference or active workflow permission: rejected template, no activation.
- Correct bootstrap signature/audience accidentally configured for state: denied before JWKS access.

## Execution sequence after design acceptance

- [x] Obtain independent design critique; resolve every blocking issue before code (two-stage pinning and explicit job.check_run_id environment mapping).
- [x] Verify official immutable action pins, Node 22.23.4 in both the official release index and actions/node-versions manifest, and source-pinning mechanics; record evidence without minting anything. Parent observed this exact runtime in existing HQ CI; stage-A ordinary CI 40755923596 subsequently passed all 171 tests on Node 22.23.4 without OIDC permission; stage-B publication must preserve ordinary CI.
- [x] Write failing reserved-audience state test; observe red, implement prefix deny, observe green/full existing suite.
- [x] Write failing bootstrap context/claim/output tests with ephemeral keys and stub fetch. Implement the minimal pure verification/projection and native one-shot transport; require no token on stdout/stderr/error objects.
- [x] Add failing transport caps, timeout, redirected URL, hostile error, no-retry/unknown-outcome tests; implement fail-closed bounds.
- [x] Add stage-A inactive template and static safety contract; assert that activation validation REJECTS its source pin placeholder.
- [x] After the reviewed script/lock source commit exists, stage B verifies its contents, replaces the pin and tests the inactive source-pinned template. Never use an old/invented SHA or copy into active workflows during local implementation.
- [x] Run focused tests and full `node --test tests/*.test.mjs`; independent code critique, then freeze file hashes. Reviewer independently confirmed 62/62 focused and 142/142 for isolated baseline 70321aa plus exactly the seven owned files, no skips. Shared 169/169 included another agent's 27 builder tests and is not the isolated bootstrap evidence.
- [x] Parent published sanitized inactive stage-A files on existing PR11 at `8342cbc80f72d2240aaa4bdc6058e78733027f20` under existing authority. Exact live activation approval remains separate; no template auto-install, OIDC permission change or mint occurs here.

Parent owns eventual one-run monitoring/cleanup only after explicit live approval. Template removal is not revocation; failed/unknown results do not authorize reruns.

## Stage-A evidence — 2026-10-28

Independent source/template critique found no remaining blocking issue for the inactive candidate. This is a local-only review, not formal approval or activation readiness. The reviewed stage-A source commit placeholder deliberately remained invalid until stage B. Read-only YAML parsing also confirmed the one-job/minimal-permission structure; no bootstrap workflow execution was performed. Exact Node 22.23.4 is in the official Linux x64 manifest and already observed by the parent in HQ CI. Stage-A ordinary CI subsequently passed the new bootstrap tests on Node 22.23.4 (171 total); local execution used Node 24.22.1. No active workflow was installed, no runtime credential was read, and no live token/JWKS request was made by this work.

## Stage-B evidence and final gates

Direct public GitHub fetch of `8342cbc80f72d2240aaa4bdc6058e78733027f20` verified the verifier/lock/manifest byte hashes recorded in the spec. Stage B changes only the inactive template, its test and these two documents; the source and auth implementation remain unchanged. The exact-pin assertion was observed failing against the old placeholder before the template update.

- [x] Obtain independent narrow review of final stage-B template/test/docs and exact combined tests: reviewer verified the four-file diff and independently reran 171/171, zero skips.
- [ ] Parent publishes the inactive stage-B candidate, verifies readback and ordinary CI.
- [ ] Present exact template hash/source commit/permissions/one-mint/output/cleanup scope for explicit user activation confirmation; check unused workflow history before any installation. No live activation is authorized by these local checkboxes.

Preactivation test caveat: the current inactive-template regression deliberately asserts that the eventual active workflow path is absent. Installing that path would therefore fail ordinary CI until an explicit activation-specific test contract is reviewed. Do not silently delete or weaken this guard.
