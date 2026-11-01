# PR #11 JavaScript OIDC + SQLite A/B isolation evidence (2026-11-01)

Status: **ISOLATED INTEGRATION TEST PASS / REMOTE A→B AND INDEPENDENT REVIEW BLOCKED**.

## Exact source and recorded execution

- Candidate implementation commit: \`9fe646ededd20efb9c30750be36c7191281ca46d\`.
- Read-only PR CI: https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41290764113
- CI outcome: 295/295 tests passed, 0 failed; the three new JS OIDC/SQLite integration tests were included.
- Existing Draft PR #11: https://github.com/haji84/PERSONAL-AI-HQ/pull/11
- PR #9 security Draft: https://github.com/haji84/PERSONAL-AI-HQ/pull/9
- No merge, new PR, permission change, new private storage, cloud deployment, secret activation, paid resource, or external dispatch was performed.

## Reused implementation and new test-only files

Existing \`scripts/hq-oidc-auth.mjs\` (pinned jose), \`workers/state-authority/worker.mjs\`, \`workers/state-authority/contract.mjs\`, \`workers/state-authority/store.mjs\`, and \`workers/state-authority/schema.sql\` are exercised without changing their production authorization boundaries.

- \`scripts/hq-sqlite-test-adapter.mjs\`: local Node \`node:sqlite\` adapter, \`BEGIN IMMEDIATE\`, cross-process database file, WAL/foreign keys and atomic rollback. **Test-only; not a hosted or cross-run storage service.**
- \`tests/fixtures/hq-oidc-sqlite-process.mjs\`: separate OS process accepting only synthetic ephemeral test input through stdin, never logging bearer tokens.
- \`tests/hq-oidc-sqlite-integration.test.mjs\`: real JS signature-verifying authorization module + state authority Worker + SQLite transactions.

## Bounded PASS observations

1. Synthetic RS256 JWT accepted with exact allowlisted GitHub-shaped claims; invalid audience, repository ID, workflow, subject, expiry, noncanonical run ID, tampered signature and forged authorization flag denied before state mutation.
2. A claimed, committed and released state; a different OS process B/C reloaded the same local SQLite file. Competing B/C claims produced exactly one success; stale epoch, wrong holder and changed-body same-idempotency-key replay were rejected.
3. The winner advanced revision/epoch to 5/2. Five distinct audit events and receipts were durable in the local file.
4. Expired lease writes denied; a forced receipt-insert failure rolled back state, events and receipts atomically.
5. CI installed the pinned dependencies through \`npm ci --ignore-scripts --no-audit --no-fund\`; the test run used actual repository code on GitHub Actions.

These observations are *not* a live token test. The signing key and JWKS were synthetic and ephemeral. Test fixture policy was owned by the harness, not a deployed trust boundary.

## Open acceptance conditions (DO NOT mark complete)

- **Actual GitHub OIDC:** no real issuer JWT was requested or verified from a hosted runner.
- **Remote persistent authority:** a SQLite file shared between OS subprocesses on one runner is not a durable service shared between distinct GitHub Actions runs. No private GitHub state repo or transactional remote service is approved.
- **Checkpoint integrity:** \`evidenceDigest\` is recorded but checkpoint payload byte storage and SHA-256 verification on B retrieval are not implemented/proven.
- **Outbox and exactly-once dispatch:** no durable outbox, claimed dispatch receipt, crash/retry side-effect test, or next-Issue automatic transition has been proven.
- **Independent AI09:** no verified distinct-model review of the exact candidate HEAD or this evidence.
- **PR #9:** self-check CI is not independent security approval; formal PR reviews were 0 at Stage 1 inspection.
- **Release:** no verified protected-main gate, human approval for merge, or post-merge verification.

## Next gated work

1. Independent technical review of this exact source and a design review of the transactional remote state/credential broker choice.
2. Add immutable checkpoint body digest verification, transactional outbox, replay and crash recovery tests locally without activation.
3. Verify an authorized cross-run remote authority only after explicit approval of storage and credential/permission changes. Recheck exact latest HEAD and separate review after changes.
4. Keep PR #11 and PR #9 Draft; do not automatically merge, publish secret-bearing workflows, or dispatch tasks.

Pass/fail must be assessed from exact-SHA CI and independent evidence, not from the document itself.
