# GitHub Actions OIDC authorization candidate — local only

Status: independently reviewed for local TDD after time-order correction and the key/cache/config constraints below. Parent approved local implementation only. No token requests, permissions changes, credentials, deployment, or resource creation. The default authority Worker remains deny-all.

## Intent, interface, and implementation choice

An isolated `scripts/hq-oidc-auth.mjs` exports `createGitHubActionsOidcAuthorizer(config, dependencies)` returning asynchronous `authorize(Request)`. Success returns exactly `{subject, executionId, repository, goal}`; every failure returns `null`, without logging. It does not consume the request body. Repository/goal come only from fixed reviewed config, validated and snapshotted at factory creation so later caller mutation cannot relax it; header/body/query values never grant scope.

Recommended approach: exact-version pinned `jose` 6.2.13 for JWT verification and local JWKS resolution, plus a small bounded fixed-URL JWKS transport. `jose` supports Workers and has no runtime dependencies. Alternative native WebCrypto avoids a dependency but makes this project maintain JOSE parsing and algorithm-confusion defenses; not recommended. The parent/core owner manages package/lockfile integration. Package installation and local implementation followed independent design review; default activation is not wired.

## Fixed trust profile

Issuer is exactly `https://token.actions.githubusercontent.com`; only RS256 is permitted. JWKS URL is compiled as `https://token.actions.githubusercontent.com/.well-known/jwks`; discovery is documentation evidence, never dynamic token-directed discovery. Require exactly one Bearer credential, at most 16 KiB, compact three-segment JWT; reject comma-joined/multiple credentials and unsupported JOSE parameters (`crit`, `b64`, `jku`, `jwk`, `x5u`, `x5c`). Header requires `typ=JWT`, bounded nonempty `kid`, `alg=RS256`.

Require issuer, one exact configured string audience (no audience arrays), `sub`, `iat`, `nbf`, `exp`, repository, repository_id, repository_owner_id, workflow_ref, workflow_sha, ref, event_name, run_id, run_attempt, and check_run_id. All identity claims have explicit bounded string types; numeric IDs are canonical positive decimal strings, never coerced. Time claims are nonnegative safe integer seconds: `nbf <= now`, `iat <= now < exp`, `nbf < exp`, `exp - iat <= 600`, and `now - iat <= 600`; zero clock leeway. Do not impose ordering between iat and nbf: GitHub's documented example permits nbf before iat. These are deliberately strict local policy, not a claim about GitHub's actual token lifetime.

Fix repository to `haji84/PERSONAL-AI-HQ`, repository_id `1437383396`, owner ID `173585154`. Require an explicit nonempty allowlist of complete tuples `(sub, workflow_ref, workflow_sha, ref, event_name, environment, job_workflow_ref, job_workflow_sha)`, not independent lists that accidentally permit combinations. SHA is exact full 40-hex. Each tuple explicitly requires environment absence or one exact value; reusable workflow claims likewise must be both absent or exactly pinned together. No wildcard, case folding, prefix matching, fallback default subjects, or default audience. Matching repository text never substitutes for immutable IDs. Goal is one fixed configuration identifier matching `[A-Za-z0-9_-]{1,80}` and is not a JWT claim.

GitHub documents legacy and immutable default subjects, colon escaping, customization, run/attempt, workflow identity, and job check-run identity. Its current issuer metadata lists check_run_id and RS256. None establishes this repository's actual configured subject or demonstrates real token refresh behavior; no live token has been observed. The exact subject policy must remain unconfigured until separately reviewed. Missing check_run_id denies, never falls back to run-only identity.

## Ownership and replay

Return `subject = hex(SHA256(JSON.stringify([issuer, repository_id, repository_owner_id, sub])))` and `executionId = hex(SHA256(JSON.stringify([repository_id, run_id, run_attempt, check_run_id])))`. Hashes are deterministic bounded identifiers, not secrets. Core combines both verified fields for holder ownership. A separate run, attempt, or check-run has a different execution identity; token `jti` is never used because refresh must not invalidate ownership. Official semantics identify check_run_id as the current job's check run; stability over real refreshed tokens remains an activation verification item, not locally proven evidence. Client holder/run fields are irrelevant.

Tokens remain bearer credentials: the adapter does not promise single-use or prevent stolen-token replay during validity. The short acceptance window limits exposure; the authority's idempotency and fenced revisions/epochs prevent duplicate or stale state mutations, not credential theft. No JWT, bearer header, decoded payload, request, exception detail, or private log is persisted or published.

## JWKS limits and fail-closed behavior

Proposed local limits: HTTPS GET only to the constant URL, redirect error, no forwarded incoming headers/cookies, 3-second total timeout covering body consumption, streaming body cap 64 KiB, maximum 20 keys. Require JSON object with unique nonempty bounded kids; RSA signing keys only, `alg=RS256`, absent-or-`sig` use, absent-or-verify-only key_ops, modulus 2048–8192 bits and odd exponent 3..2^32-1, both bounded before key import. Reject private JWK parameters. Never follow key/certificate URLs or use embedded token keys. Malformed/ambiguous keys fail closed.

Cache only validated public key material for at most five minutes per adapter instance; no token/claims cache or negative-kid map. One refresh maximum per 30 seconds (including failures), no signature-failure refresh, no retry loop. Fresh known key verifies locally. Cache expiry or unknown kid triggers at most one allowed refresh; unavailable, expired, absent, duplicate or mismatched key returns null. Never use expired cached keys after a failed fetch. Cache replacement occurs only after complete validation. Store no cross-request Response, stream, Request, token or pending I/O promise: concurrent misses during a refresh deny safely and may retry later. These per-isolate bounds are not a global service rate limit.

## Independent local verification

Only ephemeral synthetic RSA keys generated in memory and stubbed JWKS responses; no fixture private keys/JWTs in git, console or test errors. Inject a fake clock/fetch at factory creation, never via request/configured client input. Production defaults use platform fetch/crypto. Tests are isolated in `tests/hq-oidc-auth.test.mjs` and must cover:

- Positive exact trust tuple, stable identity across refreshed synthetic tokens, distinct run/attempt/job identities, and unchanged unread request body.
- Missing/invalid config denies without fetch; malformed credentials/encoding/header/type, `none`/HS/other algorithms, bad signatures and invalid/missing/array/oversized claims all deny.
- Every trust field mismatch, tuple cross-product, wrong immutable IDs despite matching names, absent/present environment and reusable claims, missing check_run_id.
- Strict expiry/not-before/issued-at boundaries, future/old tokens, excessive lifetime, negative/fractional/unsafe dates.
- Fixed URL/no auth forwarding/no redirects, unknown kid, duplicate kid, key substitution, malformed or oversized/streaming JWKS, timeout, HTTP/network errors, TTL and refresh cooldown/concurrency, no stale fallback or unbounded map. Failed/partial refresh never extends cache validity or strands the refresh guard; fresh known keys remain usable during unknown-kid cooldown.
- Default Worker still denies and authorization denial never touches D1. No local test claims live GitHub authentication, cross-Actions evidence, remote D1 correctness, or zero-cost account verification.

## Before activation (separate approval)

Review exact audience/goal/trust tuples and approved workflow SHA; establish actual repository subject configuration, signed claim types/check_run_id and refresh stability without public token logging; approve OIDC requesting permission, endpoint deployment, dedicated resources, quota/cost plan, logging/retention, and independent security gate. A pinned workflow context does not prove safety of untrusted code it executes; token-request scope and the dedicated approved job must be reviewed. check_run_id distinguishes jobs, but is not an authorization allowlist. This adapter authenticates an execution, not authority to merge, publish, spend or change permissions.

Sources checked 2026-10-28: [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc), [issuer metadata](https://token.actions.githubusercontent.com/.well-known/openid-configuration), [JWT BCP RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), [JWT RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html), [jose official repository](https://github.com/panva/jose), [Workers WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/). Local current Workers types inspected: `5.20261028.1`; no Worker configuration changes needed for design.
