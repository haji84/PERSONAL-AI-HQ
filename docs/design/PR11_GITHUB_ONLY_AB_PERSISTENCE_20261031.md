# PR #11: GitHub-only A/B persistence architecture decision candidate (2026-10-31)

Status: DESIGN CANDIDATE / NOT ACTIVATED / NOT INDEPENDENTLY APPROVED. Keep PR #11 Draft. No Cloudflare, Codex or Work dependency.

## Scope
Only synthetic checkpoints; no user GPS, model raw prompts, credentials or private evidence. No new PR, main merge, permission change, private repository provisioning, paid resource or workflow dispatch under this change.

## Proposed durable authority
Use a dedicated private GitHub repository for checkpoint commits. A protected fixed ref identifies the latest immutable state commit. Commit creation is not an authority grant. A trusted coordinator must validate execution identity and perform a *conditional* ref update against an expected old object ID. Do not assume GitHub Contents API update or Actions concurrency provides an atomic cross-run lease. Verify the actual API semantics with a race test before use. If conditional ref CAS cannot be proven, fail closed and choose a transactional store instead.

## Authentication
A and B have distinct GitHub Actions run IDs and attempts. A GitHub OIDC JWT is only an identity assertion to a verifier; it is NOT itself an authorized GitHub write credential. An owner-approved credential broker/GitHub App installation with restricted repository scope would be needed; its permissions, token lifetime, audience, repository/ref/environment claims and rotation must undergo independent review before activation. Never pass a PAT via PR code or accept caller-provided run IDs as authentication. Repository creation and permissions are explicit human gates.

## State envelope
Canonical JSON includes schemaVersion, repository, goal, jobId, revision, epoch, state, holderExecutionId, leaseExpiry, parentCheckpointSha256, evidenceSha256, dispatchNonce and eventChainSha256. The verifier binds caller identity to run ID/attempt and checks allowlisted transitions. An expired holder cannot commit, even if it read a valid checkpoint earlier. Use a trusted server time at commit; client clock is insufficient. Immutable audit events bind predecessor hash, state hash and action. Idempotency receipt binds exact operation+principal+request hash. Duplicate dispatch must be prevented by persisted receipt before any downstream action.

## Required acceptance tests
1. A writes synthetic checkpoint and records run ID, attempt, immutable state commit and digest.
2. Separate run B authenticates, verifies A's checkpoint, acquires a new epoch atomically, advances exactly one synthetic next task.
3. Two B runs racing for same revision: exactly one succeeds; losing runner cannot commit.
4. Stale A, expired lease, wrong principal, tampered digest, replayed idempotency key with altered body, old revision, wrong repository and duplicate dispatch are rejected.
5. Crash between state claim and dispatch recovers without duplicate side effect. Audit evidence is sanitized and independently checked against exact head SHA.
6. Independent security review of PR #9 and implementation diff is a separate gate; main merge and actual autonomous dispatch remain BLOCKED until explicitly authorized.

## Known blocker
No verified private state repository, trusted credential exchange, conditional ref CAS implementation, or observed two-run Actions E2E. The local SQLite subprocess tests are useful unit-level evidence, not remote E2E proof. Next action is independent architecture review and read-only capability checks, then request scoped authorization for provisioning/authentication before activation.
