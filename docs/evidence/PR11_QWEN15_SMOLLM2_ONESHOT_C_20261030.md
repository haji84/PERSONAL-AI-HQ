# PR #11: owner-approved Qwen 1.5B -> SmolLM2 real one-shot evidence (2026-10-30 JST)

## Result: PASS for one bounded public synthetic two-model cycle; overall autonomous development remains BLOCKED

**Measured run:** https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41074531049
- Workflow: `PR11 owner approved Qwen1.5B SmolLM2 once 20261030c`
- Job: `124127060917`, run number **1**, attempt **1**, final GitHub conclusion **SUCCESS**
- Approved, exact frozen source checkout: `8b3a613da16458f7960ae2a896759f9810523a8a`.
- Activation commit: `ad94f4341abef0a9a29e7212de5b068a32a15b9e`.
- Run was single-use, `pull_request:synchronize`, path-restricted, source-SHA-locked and read-only `contents:read`. No `id-token:write`, repository write token, secrets, private user data or uploads were used.
- The runner passed the original **286/286 immutable project/security/synthetic tests** before downloading weights or starting any model.
- Public llama.cpp b11968 runtime, public SmolLM2 weights and newly selected public Qwen1.5B weights were downloaded to an ephemeral Ubuntu runner and verified against pinned SHA-256 values.

## Genuine observed model process results

| Proof | Observed value |
|---|---|
| Implementation model | **Qwen2.5-Coder-1.5B-Instruct-GGUF Q4_K_M**, verified SHA-256 `cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046` |
| Qwen builder processes / actual attempted model calls | **1 / 1** |
| Qwen observed completion | `builderObserved=true` |
| Qwen model response SHA-256 | `6c22a8050d08c7505dfed81eb1461e2a079186e521133b20514147300175ec5b` |
| Qwen-generated candidate source SHA-256 | `ba1a531f581d2e6094e978ed6f7aca7a8d92eeb62c6e7ad73ee692f7f18bc772` |
| Changed meaning relative to old subtraction code | `builderSemanticNoOp=false` |
| Original six immutable arithmetic cases | `retestCases=6`, all **PASS** |
| Immutable acceptance-set SHA-256 | `f0088dc4e91c70eb811ecc44725e2366ea0f65fd616db9aae3e2bfb72b51d536` |
| Review model | **SmolLM2-1.7B-Instruct-GGUF**, verified SHA-256 `decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33` |
| Real SmolLM2 reviewer calls / observed completion | **1 / true** |
| SmolLM2 observed response SHA-256 | `41ee99ff522d1060df4de48963bd21cb2f98ee752b7df36586f4c6cb853ed71b` |
| Model review status | `ADVISORY_AGREEMENT`, `witnessValid=true`, `advisoryAgrees=true` |
| Exact source binding | `modelSourceBound=true`; generated source, reviewed source, and review prompt source all had the *same* candidate source SHA-256 |
| Bounded review receipt SHA-256 | `1a71553194f57a9ad1507729f55c02032510f24af4587a5ce26d86eea693d9d6` |
| Local exact-source review checkpoint SHA-256 | `579cddc881599e96e3aefd6ea0e42fa1810261fdac66e109899c23752647ca16` |
| Checkpoint restored and independently verified by another local OS process | `localCheckpointVerified=true`, `separateProcessResume=true` |
| Persisted retest/no-op metadata | `builderRetestStored=true`, `builderNoOpStored=true` |

Qwen's generated source hash agrees with the public synthetic canonical addition implementation `def add(a, b):\n    return a + b\n`. That correspondence was independently recomputed from the known public candidate, not obtained by retaining or publishing the model's raw output. This is one specific fixture; it does not establish general coding quality.

**Model source:** Qwen official Hugging Face repository commit `2ab9f8f42af02fc212effaef7c4850c885e965f4`, file `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`:
- https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/tree/2ab9f8f42af02fc212effaef7c4850c885e965f4
- https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/2ab9f8f42af02fc212effaef7c4850c885e965f4/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

## Authorization and fail-closed state

This **does not** constitute independent review of PR #9 or permission to merge code:
- Final `state=BLOCKED`, `releaseAuthorized=false`, `nextTaskDispatched=false`, `remotePersistence=false`, `independentSecurityApproval=false`.
- The model review is advisory of **one fixed public-synthetic arithmetic task**. SmolLM2's model identity and its exact source binding were observed; there was no unrelated authenticated human/GitHub security approval.
- The saved checkpoint was **inside the same ephemeral GitHub Actions job**, then read by a fresh OS process in that job. It did **not** survive the host's destruction and is **not proof of two separate GitHub Actions runs using a durable remote store**.
- No independent PR #9 security review, authenticated durable repository state, next-Issue dispatch, general code task, actual PR repair, or main merge was performed.
- The owner's permission was for **one** trial, and that approval was consumed. This run was not retried.

## Cleanup and post-activation verification

- Temporary workflow removed: `33ee123b782a4b0f5aec8166d0084a8cae4f3812`.
- Temporary one-use Node helper removed: `e4b686a528ab186291c03646cb8097ddcef40545`.
- Temporary one-use Python model preparer removed: `c37b7c4b1a62e896599992e147f05aa914771326`.
- Pre-run stable PR #11 HEAD: `fdf329f57a6e36caeaea6bbad8b4b74b3e1a869a`. GitHub compare to cleanup HEAD `c37b7c4b1a62e896599992e147f05aa914771326` returned **two modified files only**: `scripts/generated-review.mjs` and `tests/generated-review.test.mjs`. These permanent, test-verified changes bind the SmolLM2 model receipt to the *actual* pinned Qwen1.5B SHA rather than mislabeling it as the legacy Qwen0.5B builder.
- During the temporary workflow, the separate ordinary read-only CI detected the expected workflow-inventory violation. The original safety test was not weakened.
- Cleanup HEAD ordinary CI https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41074879636 succeeded: **286/286 PASS, 0 fail, 0 skip**, including the strict workflow-inventory check.
- The run's GitHub Actions artifact listing returned **zero artifacts**. No raw model prompts, source, responses, private GPS, credentials, or model weights were uploaded as Actions artifacts.
- No new Cloudflare resource, remote store, paid service, API key, repository permissions, deployment, main merge, external publication or unauthorized retry took place.
- PR #11 remained Draft and unmerged.

## Next acceptance barrier

The bounded local two-model *synthetic* demonstration has succeeded. The full project remains **UNPASSED**. The next independent gates are (1) formal distinct-source security review of current PR #9 plus protected acceptance policy; (2) owner-authorized, authenticated durable external state with transactional lease fencing, replay protection, evidence retention and verified caller identity; and (3) **two distinct GitHub Actions runs** that safely persist and resume a real approved state, followed by an authorized next work item. None can be inferred from this successful one-shot.
