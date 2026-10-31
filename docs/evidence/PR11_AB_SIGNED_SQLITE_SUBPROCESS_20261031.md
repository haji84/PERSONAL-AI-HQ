PR #11 synthetic signed-token SQLite A/B process test (2026-10-31)

STATUS: ISOLATED PYTHON PROOF ONLY, NOT EXISTING JS OIDC INTEGRATION OR INDEPENDENT MODEL REVIEW.

Local execution: Python 3.13 cryptography RS256 synthetic JWT signer/verifier; SQLite BEGIN IMMEDIATE transactions, revision/epoch fencing, persisted receipts and events. Separate OS subprocesses A and B executed. Two independent subprocess contenders raced for one revision; exactly one won. Stale writer, wrong holder, expired lease, tampered signature, expired token and conflicting idempotency replay rejected. Audit rows and receipts verified. First run exposed a test harness error when an authentication rejection emitted no JSON; harness was corrected to report denied authorization, then rerun PASS.

IMPORTANT LIMITATIONS: Synthetic issuer/audience and locally generated RSA key; NOT actual GitHub OIDC. Python verifier does not implement all constraints in scripts/hq-oidc-auth.mjs. Caller-supplied test time is not a server-trusted clock. SQLite is local and not shared between GitHub-hosted Actions runners. No durable outbox dispatch test, no independent model response, no live two-run Actions test. Local source is not merged into the PR production implementation.

Review decision: BLOCKED. Next implement integration tests against actual existing JS OIDC verifier with synthetic signed JWT and independently verify the exact SHA; assess transactional backend architecture for remote runners. No provisioning, permission changes, workflow activation or main merge.
