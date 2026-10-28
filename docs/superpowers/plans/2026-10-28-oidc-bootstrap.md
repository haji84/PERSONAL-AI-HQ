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
- [x] Verify official immutable action pins, Node 22.23.4 in both the official release index and actions/node-versions manifest, and source-pinning mechanics; record evidence without minting anything. Parent observed this exact runtime in existing HQ CI; bootstrap tests must pass normal read-only Node 22 CI after inactive publication before activation.
- [x] Write failing reserved-audience state test; observe red, implement prefix deny, observe green/full existing suite.
- [x] Write failing bootstrap context/claim/output tests with ephemeral keys and stub fetch. Implement the minimal pure verification/projection and native one-shot transport; require no token on stdout/stderr/error objects.
- [x] Add failing transport caps, timeout, redirected URL, hostile error, no-retry/unknown-outcome tests; implement fail-closed bounds.
- [x] Add stage-A inactive template and static safety contract; assert that activation validation REJECTS its source pin placeholder.
- [ ] After the reviewed script/lock source commit exists, stage B verifies its contents, replaces the pin and tests activation-readiness. Never use an old/invented SHA or copy into active workflows during local implementation.
- [x] Run focused tests and full `node --test tests/*.test.mjs`; independent code critique, then freeze file hashes. Reviewer independently confirmed 62/62 focused and 142/142 for isolated baseline 70321aa plus exactly the seven owned files, no skips. Shared 169/169 included another agent's 27 builder tests and is not the isolated bootstrap evidence.
- [ ] Parent may publish sanitized inactive files on existing PR11 under existing authority. Exact live activation approval remains separate; no template auto-install, OIDC permission change or mint occurs here.

Parent owns eventual one-run monitoring/cleanup only after explicit live approval. Template removal is not revocation; failed/unknown results do not authorize reruns.

## Stage-A evidence — 2026-10-28

Independent source/template critique found no remaining blocking issue for the inactive candidate. This is a local-only review, not formal approval or activation readiness. The reviewed source commit placeholder deliberately remains invalid. Read-only YAML parsing also confirmed the one-job/minimal-permission structure; no GitHub runtime execution was performed. Exact Node 22.23.4 is in the official Linux x64 manifest and already observed by the parent in HQ CI. The new bootstrap tests still require Node 22 CI before activation; local execution used Node 24.22.1. No active workflow was installed, no runtime credential was read, and no live token/JWKS request was made by this work.
