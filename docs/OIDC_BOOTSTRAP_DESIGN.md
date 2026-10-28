# PR11 OIDC bootstrap proof — inactive design

Status: independently reviewed and synthetic-tested as an inactive stage-A candidate, with the two-stage source-pin process below. This document authorizes no live workflow, token request, permission change, Cloudflare action, or account-plan verification. The eventual template must remain outside `.github/workflows` until the user approves the exact activation candidate.

## Purpose and boundaries

Establish the repository's actual signed GitHub OIDC subject and run/job claims once, without deploying a service or publishing a JWT. A successful proof is evidence about that particular bootstrap workflow/run, not a production allowlist, authorization to access state, GitHub formal approval, or proof of safe untrusted workflow code. The existing default state Worker remains deny-all.

Proposed owned files after design review: `templates/oidc-bootstrap.yml.example`, `scripts/oidc-bootstrap-proof.mjs`, `tests/oidc-bootstrap-proof.test.mjs`, this spec and its isolated plan. A separately reviewed small tightening in `scripts/hq-oidc-auth.mjs` and its tests reserves the bootstrap audience namespace. No edits to active workflows, resources, secrets, other applications, or existing activation configuration.

## Approach decision

Recommended: a Node script using exact pinned `jose` 6.2.13 and one bounded native fetch to GitHub's documented runtime token-request endpoint, then one bounded fetch to the fixed GitHub JWKS endpoint. The official Actions toolkit `getIDToken(audience)` is the normal alternative, but its inspected implementation enables retries (up to ten), debug-logs the request URL, and emits a masking command containing the token. Those behaviors do not fit the one-attempt/no-token-output contract, so the proposed script does not import it.

The one-shot verifier is intentionally separate from the state authorizer: it has no cache/refresh/retry facility and never returns raw claims to its caller. Reuse `jose`, not a generic public raw-claims API or a new production trust-policy bypass. Duplicate the small fixed issuer/header/key bounds with dedicated tests; do not refactor the already-reviewed state verifier during this slice.

## Audience separation

Reserve the exact case-sensitive namespace `urn:personal-ai-hq:oidc-bootstrap:`. Initial proof audience is `urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v1`, compiled into the script, not a CLI/environment argument. The state authorizer must reject configuration whose audience starts with that reserved prefix before network access; exact-audience matching then makes bootstrap credentials unusable for state even after future activation. Add a regression that a valid signed synthetic bootstrap token still cannot authorize state when someone supplies the matching forbidden configuration. A mere differently named example audience is insufficient.

## Inactive template and future one-shot gate

The template describes a new unique workflow path `.github/workflows/hq-oidc-bootstrap-pr11-v1.yml` and workflow name, whose absent/current history must be checked before activation. It is not installed at that path now. Its only trigger is `pull_request` with `types: [synchronize]`, targeting base branch `main`; no dispatch, schedule, push, workflow_run, pull_request_target, reusable call, labels, matrix, dependencies on other jobs, or automatic reruns.

There is exactly one job. Workflow-wide permissions are empty; only that job has `contents: read` and `id-token: write`. Job-level pre-run conditions require all of:

- Event `pull_request`, action `synchronize`, PR number 11; base `main`, head branch `feature/autonomous-manager-bootstrap`, and ref `refs/pull/11/merge`.
- Repository and PR head/base full names exactly `haji84/PERSONAL-AI-HQ`, repository IDs `1437383396`, owner ID `173585154`, public visibility, no fork/null head.
- `github.run_number == '1'` and `github.run_attempt == '1'`. A new run or rerun fails closed; unexpected initial counters are not reset or worked around without fresh approval.

The script repeats the guards before requesting a token, using documented platform environment/context values and a bounded event-file read. It also requires a GitHub-hosted Linux runner, exact expected workflow ref/path, canonical run/check-run IDs, and full SHA values. check_run_id comes from the documented `job.check_run_id` expression in an explicit script environment field; no `GITHUB_CHECK_RUN_ID` variable is assumed. Contexts are passed as individual environment values, never interpolated into shell source or dumped wholesale.

Use full immutable commit SHAs for official checkout/setup-node actions, an exact Node patch version, and an immutable reviewed verifier-source commit SHA for checkout. `persist-credentials: false`, no cache restoration, no artifacts, no checkout/execution of mutable PR code, no repo lifecycle scripts, and `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` from the pinned source/lock. Activation validation rejects placeholders, branches, tags or non-full SHAs. Two explicit states avoid a circular source pin: stage A publishes reviewed verifier/tests/lock plus an inactive draft whose placeholder is expected to FAIL activation validation; stage B replaces it only after verifying that the actual reviewed source commit contains the verifier and matching lock. Stage B then passes activation-ready checks but still remains outside active workflows pending user approval. No invented or earlier commit lacking the script may be substituted just to pass a test. Official action pins and the exact Node patch are verified during local implementation, then included in the activation-review package.

Because the active YAML cannot contain its own commit hash without circularity, do not claim an embedded self-SHA check. The parent reviews the exact activation commit/template externally before publishing it; the script compares signed workflow_sha with platform `GITHUB_WORKFLOW_SHA` and records that verified public SHA. The executable verifier source is independently pinned to an earlier reviewed commit. An unforeseen workflow SHA/format mismatch fails; it is never accepted by loosening checks automatically.

Activating this synchronize-only template by an explicitly approved PR11 push is the sole intended trigger. First-run and first-attempt guards bound subsequent automatic executions. These controls do not revoke credentials or prevent a compromised already-authorized job from abusing its job-scoped capability.

## Token acquisition and verification

The live entry point requires the literal command flag `--github-oidc-bootstrap-once`; importing the module or running tests never requests credentials. No token, audience, arbitrary URL, or shell command may be supplied as a CLI argument. The script reads `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` only after the context checks pass.

Validate the runtime-provided request URL as HTTPS, no username/password/fragment/port, hostname ending in the exact DNS suffix `.actions.githubusercontent.com` (not a string lookalike), and no existing audience parameter. This is a conservative proposed host policy, not a claim that GitHub documents an immutable mint endpoint hostname; an unfamiliar runtime endpoint fails closed before sending the bearer credential and requires review. Add the single fixed audience with URLSearchParams. Make exactly one GET with redirect disabled, no retry, cookies or forwarded headers; the runner request credential appears only in that request's Authorization header. Token-controlled URLs are never used.

Runtime URL length is capped at 2048 characters and request credential at 16384, without whitespace/control characters; reject pre-existing audience keys case-insensitively (including percent-decoded names). Invalid public context must not even read runtime credential getters. The job timeout is five minutes and the template contains exactly one proof invocation, without continue-on-error.

Bound both token-request response and JWKS fetch by three seconds through body consumption, streaming byte limits (32 KiB token-response envelope; 64 KiB JWKS), and strict UTF-8/JSON types. Require exactly one bounded compact token in response.value (JWT at most 16 KiB); do not log or persist response fields. Clear local references after use where possible; do not claim secure erasure of immutable JavaScript strings. No child process, temporary token file, environment export, GITHUB_OUTPUT, artifact, summary, masking command, or debug output receives a token. No catch handler prints an exception/error object, request URL, status body, headers, or decoded payload.

JWT verification requires `RS256`, `typ=JWT`, a bounded kid, canonical compact encoding, and forbids `crit`, `b64`, `jku`, `jwk`, `x5u`, and token `x5c`. Use only fixed issuer `https://token.actions.githubusercontent.com` and fixed JWKS `https://token.actions.githubusercontent.com/.well-known/jwks`, no discovery or fallback. JWKS checks follow the existing adapter: maximum 20 unique kids, RSA/signature-only, no private parameters, canonical modulus 2048–8192 bits and odd exponent 3..2^32-1 before import. Unknown/duplicate kid, malformed/oversized/redirected/unavailable keys, or verification errors yield one generic failure, never another mint/fetch attempt.

Require numeric-date iat/nbf/exp as nonnegative safe integer seconds, independent `nbf <= now`, `iat <= now < exp`, `nbf < exp`, maximum 600-second lifetime/age, zero skew; recheck at completion. Require exact audience string (no array), repository name/immutable IDs/public visibility, event pull_request, fixed PR11 merge ref, approved head/base branch literals, expected workflow_ref and workflow_sha matching platform context. Require no environment or reusable-workflow claims; explicit null is not absence. Signed run_id/check_run_id must equal platform context, run_number and run_attempt exactly canonical string `'1'`; absent/number/array/coerced identities fail.

Subject may be exactly one of the two public PR subjects below; all custom, malformed or unexpected subjects fail generically rather than being disclosed:

- `repo:haji84/PERSONAL-AI-HQ:pull_request`
- `repo:haji84@173585154/PERSONAL-AI-HQ@1437383396:pull_request`

Allowing these two discovery-proof subjects does not install either as a state API policy. Actual repository OIDC configuration is still unknown until independently verified evidence exists.

## Public output and cleanup

After every check succeeds, emit exactly one bounded JSON object containing only these validated signed claim keys: `sub`, `repository`, `repository_id`, `repository_owner_id`, `ref`, `workflow_ref`, `workflow_sha`, `run_id`, `run_number`, `run_attempt`, `check_run_id`. Build a new object field-by-field; never spread the payload. Fields are either exact known public literals or canonical numeric IDs/full hex SHA. Never output actor/email, arbitrary branch/environment, custom properties, jti, time claims, signature, raw token or full claim/header objects. Failure emits only `OIDC_BOOTSTRAP_FAILED` and exits nonzero. Success does not edit policy or access any state endpoint.

After the one authorized run reaches a terminal state—success, failure or unknown outcome—the parent removes the active bootstrap job/workflow and its id-token permission. No automatic rerun, retry, renamed-workflow workaround or second mint is authorized. Verify the removal commit and no remaining intended active permission. Removal prevents future normal activation from the current tree; it is **not token revocation** and does not erase old workflow history or guarantee that historical reruns are impossible. Already issued tokens remain time-bounded bearer credentials; state rejects the reserved audience independently.

## Local test contract and activation gates

Local tests use only ephemeral in-memory synthetic RSA keys and stubbed mint/JWKS fetches, including all rejection paths; no actual GitHub request environment or public JWKS network call. Tests prove zero network on invalid context/config/counters, exactly one mint and one JWKS request on success, generic output under hostile errors, no arbitrary claims leaked, no retries even on uncertain token responses, output exact-key schema, and reserved-audience state rejection. Template tests require inactive placement, exactly one job, job-scoped minimal permissions, counter/PR/repo/branch guards, immutable pins, no banned triggers/cache/artifact/logging commands, and no changes to active workflow permissions.

Before any live activation: independent design and code critique, red/green local tests, full existing suite, sanitized source/template/lock review, verified immutable action/source pins, exact activation commit approval, unused workflow path/history check, and explicit user approval for the temporary permission, one token request and planned cleanup. Missing claims or unexpected counters/endpoint/subject are blockers, not permission to relax policy. No Cloudflare provision/deploy, state API access, billing/account changes or new persistent credentials are part of this proof.

Sources checked 2026-10-28: [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc), [GitHub variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables), [GitHub contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [official toolkit OIDC implementation](https://raw.githubusercontent.com/actions/toolkit/main/packages/core/src/oidc-utils.ts), [official runner runtime injection](https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs), [jose pinned API](https://raw.githubusercontent.com/panva/jose/v6.2.13/docs/jwt/verify/interfaces/JWTVerifyOptions.md).

## Stage-A pin evidence

Official release/commit pages and pinned action manifests were inspected: [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) at `3d3c42e5aac5ba805825da76410c181273ba90b1`; [setup-node v7.1.0](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1) at `949feb2413d6458794dcd2491c4babbbce0c15c1`. The [official Node release index](https://nodejs.org/dist/index.json) lists exact LTS patch `22.23.4`; setup-node automatic package caching is explicitly disabled. The source commit remains the deliberately invalid `REQUIRES_REVIEWED_SOURCE_COMMIT` placeholder in stage A. It is not activation-ready and cannot be substituted with the baseline commit, which does not contain this new script.

## Stage-A local verification

Independent actual-source critique found no remaining blocker for the inactive candidate. The reviewer reran 62/62 focused auth/bootstrap tests and 142/142 tests against isolated baseline `70321aa4a3290073f327ede30949559fca4697a2` plus only the seven owned bootstrap/auth files; zero failures or skips. Shared-tree 169/169 also included 27 unrelated local-builder tests and is not claimed as the isolated bootstrap result. The source placeholder remains deliberately invalid; no active workflow, credential request or live JWKS fetch was performed.

The final template selects exact Node `22.23.4`, not the initially considered newer `24.22.2`. Both the [official Node release index](https://nodejs.org/dist/index.json) and [official actions/node-versions manifest](https://raw.githubusercontent.com/actions/node-versions/main/versions-manifest.json) confirm `22.23.4`, including the Linux x64 asset under release `22.23.4-39619033003`. The parent observed that exact runtime in existing HQ CI run `40751784751`. Local tests here used Node `24.22.1`; normal read-only CI after inactive publication must also pass the bootstrap tests on Node 22 before activation. Actual reviewed source/lock commit pin, unused workflow history, exact candidate review and explicit temporary-permission/one-mint approval remain preactivation gates.
