# PR #11 independent-review preparation: local A/B and auth findings (2026-10-31)

Status: TECHNICAL PRE-REVIEW, NOT INDEPENDENT MODEL APPROVAL. No infrastructure, permissions, workflow activation, or merge authorized.

## Evidence checked
- PR #11 branch feature/autonomous-manager-bootstrap, still Draft; GitHub formal reviews: 0 at inspection.
- scripts/hq-oidc-auth.mjs validates issuer, JWT signature/JWKS, audience, repository identifiers, allowlisted workflow/ref, run ID/attempt/check-run ID and expiry. This is source inspection, not successful live authentication.
- scripts/checkpoint-transfer.mjs provides AES-256-GCM envelope for synthetic review checkpoints. Its key possession does not prove runner identity or cloud persistence.
- workers/state-authority/store.mjs uses transactional SQL with revision/epoch/holder/expiry predicates and receipt checks. This D1 implementation is not a GitHub-ref CAS implementation.
- docs/design/PR11_GITHUB_ONLY_AB_PERSISTENCE_20261031.md is a design candidate; no broker, trusted clock or atomic Git ref CAS has been proven.

## Local fixture reproduction
Command sequence with a fresh temporary SQLite database: python state_demo.py DB A; python state_demo.py DB B; python state_demo.py DB STALE; python state_demo.py DB B. Observed A success (revision 1, epoch 1), B success (revision 2, epoch 2), stale A rejected, second B rejected. The synthetic payload SHA-256 was 4aa1bf4e3fa71a9a654d303a535c5b0a6e9396c23a69ca050f30b17798f7d2b6. The fixture has no GitHub authentication and no server-trusted clock.

## Blocking findings
F1 HIGH: GitHub Contents API is not an established cross-run atomic lease; require tested CAS or transactional alternative.
F2 HIGH: GitHub Actions OIDC does not by itself grant write permission to another private repository; verified exchange and minimum-scope credentials require explicit authorization.
F3 HIGH: Lease expiry and fencing require a trusted authority at mutation time; client clock and Actions concurrency are insufficient.
F4 HIGH: Atomic checkpoint claim and downstream dispatch need crash/retry idempotency; duplicate side effects must be tested.
F5 MEDIUM: Existing local SQLite demonstration does not exercise real OIDC, cross-run credentials, server-clock expiry, remote concurrent writes, or evidence retention.

## Decision
FAIL-CLOSED / BLOCKED for remote activation. Next: independently review F1-F4 against an exact implementation SHA; test local malicious/expired token fixtures and two-writer conflict; request explicit owner authorization before creating private repository or changing permissions. Keep PR #11 Draft, no main merge.
