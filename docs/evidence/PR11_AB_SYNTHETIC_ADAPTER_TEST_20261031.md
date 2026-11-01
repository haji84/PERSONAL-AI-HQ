PR #11 A/B synthetic adapter verification (2026-10-31)

STATUS: LOCAL UNIT TEST ONLY. No live OIDC, durable backend, independent model review, or cross-Actions proof.

Node.js in-memory synthetic adapter: 3/3 node:test PASS.
1. A claim, expiry, B reclaim/new epoch, stale A rejected, B evidence commit.
2. Two simultaneous Promise-based B claims: exactly one succeeds.
3. Synthetic unauthorized principal, changed-key replay, scope mismatch and expired lease rejected.

CRITICAL LIMITATIONS: Caller-provided verified:true is NOT authentication and must never reach production. Single-process memory is NOT durable, and Promise concurrency is NOT proof of cross-process atomicity. The clock is caller-provided and is not a trusted server clock. Tests were run in an isolated local fixture, not added to the PR as production code.

Independent review findings to resolve:
F1 CRITICAL: integrate actual signature-verified OIDC identity with immutable execution principal; no caller-provided trust flag.
F2 CRITICAL: implement and prove atomic cross-process compare-and-swap or transactional store.
F3 HIGH: enforce trusted-time lease expiry and fencing at commit.
F4 HIGH: persist idempotency receipts and dispatch outbox atomically; crash recovery cannot duplicate side effects.

Decision: BLOCKED for activation. PR #11 remains Draft. No private repository, credentials, permissions, workflow dispatch, new PR, or main merge authorized. Next: synthetic signed-token integration test against local transactional backend, followed by independent model review of exact SHA.
