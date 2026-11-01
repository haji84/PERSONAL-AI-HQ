# PR #11 owner-approved one-shot B, measured failure and cleanup (2026-10-30 JST)

## Formal outcome: FAIL / BLOCKED (authorization consumed)

This is the **second, separately owner-authorized** one-time public-synthetic, read-only GitHub-hosted inference experiment. It does not supersede the earlier failed run 40916992079. No automatic retry or second inference was performed under this authorization.

- Actual workflow: https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41011039193
- Job ID `123916733110`; unique workflow name `PR11 owner approved models once 20261030b`, run number 1, attempt 1. Final conclusion **FAILURE** (exit 2).
- Frozen code checkout: `efe57adcb5c90cf12735964362a6635cbcd605b5`. The one-off helper was on this frozen commit.
- SHA-pinned llama.cpp runtime, Qwen builder weights, and SmolLM2 reviewer weights were successfully downloaded to a short-lived public-runner directory and verified.
- Before inference, the frozen 278-case test suite returned **278 PASS, zero fail/skip**.
- `Qwen`: exactly **one** actual model process launched and completed, with verified pinned model hash `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32`.
- Qwen response SHA-256: `ed091f13d09e5657e0fad0a96e020da9f0f0f99fe24bfbab6e8357bbb76d0cc4`.
- Generated candidate SHA-256: `3803a0bed9badd513968af60e4b9b4ad1e47087d4f49c01b955f4133f18a22b3`.
- Original immutable Python acceptance-set hash: `f0088dc4e91c70eb811ecc44725e2366ea0f65fd616db9aae3e2bfb72b51d536`.

## Concrete failure diagnosis

The newly persisted allowlisted diagnostic was:

```json
{"outcome":"ASSERTION_FAILURE","caseId":"case-1","observedCaseCount":null}
```

The first of the six fixed cases is `add(2, 3)` with expected value `5`. The accepted code did **not** produce the expected result. This is a numeric assertion failure, **not** a reported syntax/whitelist rejection.

The exact candidate digest matches the previous approved one-shot's candidate SHA-256 `3803a0...4133f18a22b3`. A separate offline SHA-256 comparison found that this exact digest matches the **public synthetic** source `def add(a,b): return a - b`. Its semantic AST digest `92d588112dc56af321cade598519d35defbd5cf13b5cdefe0f381c4ea6e7b401` exactly matches the original subtraction seed `def add(a, b):\n    return a - b\n`. This source was *reconstructed by matching the digest*, not recovered as the original raw inference log, and it contains no private content. Its behavior fails case 1 (2 - 3 = -1, not 5). The repeated no-op semantic output should be addressed before granting any new model run.

The Qwen model's raw response and detailed process prompts were NOT uploaded to GitHub. A SHA match is not a substitute for an independently retained raw-response attestation.

## Reviewer, state and release gates

- SmolLM2 model **calls: 0**; not executed because Qwen's generated code failed the immutable retest.
- Actual reviewer result, model-source bound receipt, review checkpoint and cloud persistence: **none**.
- The bounded retest diagnostic was persisted in `model-cycle-result.json` in the ephemeral job workspace (`builderRetestStored=true`). This is local-only evidence and was destroyed with the ephemeral runner. The public sanitized job log contains only the bounded case identifier, source/model hashes and false release booleans.
- The workflow emitted `state=BLOCKED`, `releaseAuthorized=false`, `nextTaskDispatched=false`, `remotePersistence=false`, `independentSecurityApproval=false`.
- PR #9's separately verified formal security review, authenticated remote state, different Actions-run resume and true model-backed autonomous development are still NOT COMPLETE.

## Cleanup and unchanged security controls

- Temporary workflow installed for this approval at `ed9b4d68eb8b3bab7f569ec3b884a55f2d95f3a1`.
- Temporary workflow deleted at `4c3ac6922c85643dbf483abf339e7b29089efcb9`.
- One-use helper deleted at `8248574c7ee30a24bdd28a01e448711c5c30d543`.
- GitHub compared the prior stable `7a51b04cf9b7732c20e52ef22e9706e0d6ba246e` with `8248574c7ee30a24bdd28a01e448711c5c30d543`: **no net changed files**.
- While temporary workflow existed, ordinary PR CI https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41011039146 reported **one expected workflow-inventory safety-test failure**. It was NOT relaxed or bypassed.
- After cleanup, ordinary PR CI https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41011251224 **278 PASS, zero fail/skip**, including the previously failing workflow-inventory test.
- GitHub reports **zero uploaded artifacts** for the one-shot run. No raw model output, private GPS, user data or weights were uploaded as a public Actions artifact.
- No main merge, publishing, billing resource, OAuth/OIDC permission, Cloudflare database, model API, secrets or privileged GitHub write permission was activated.

## Next safe technical decision

Do **not** simply repeat the same Qwen prompt/run. Analyze why the pinned Qwen 0.5B builder produced a semantically unchanged arithmetic subtraction despite a correction request. Consider narrow offline changes to reject AST-identical no-op proposals *before* accepting them as progress, and independently review any bounded prompt/adapter adjustment. An additional real-model run requires a new explicit one-shot authorization. Do not count 278 passing synthetic tests as proof of the missing real Qwen-to-SmolLM2 review, independently authorized remote checkpoint, or next-job transition.
