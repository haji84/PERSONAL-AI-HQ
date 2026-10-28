# PR #11: local different-model advisory evidence — 2026-10-28

## Initial paired observation (immutable)
Two actual SmolLM2 model executions produced **one accepted advisory and one schema-rejected response**. This is not a passing two-case review and grants no approval or merge authority.

- Builder artifact: official Qwen2.5-Coder-0.5B-Instruct GGUF, SHA256 `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32`.
- Reviewer artifact: official HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF, revision `2d4a76a30b4af41ecd395c35725ac11688d4cfe4`, Q4_K_M, 1,055,609,536 bytes, SHA256 `decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33`. Official publisher model card declares Apache-2.0; no inference API, account, key, or paid model endpoint was used.
- Both use the same pinned official llama.cpp b11968 runtime. Distinct model family/weights and fresh processes establish local artifact separation, not provider-attested identity, training independence, or a security-grade reviewer.
- Original paired receipt: 14,636 bytes, SHA256 `c801e1da3b1f51bb7237c2f0d1c8d62bca9fb26301db48a6be38d1173c5fa183`.

| Synthetic fixture | Observed model result | Host validation |
|---|---|---|
| Host-seeded subtraction defect | `defect`, witness inputs 5 and 3, actual 2, required 8 | Accepted advisory; witness independently reproduced |
| Previously generated Qwen addition repair | `no_defect`, but empty reason | Strict schema rejection; numeric plausibility does not override failure |

The defective-case raw response SHA256 is `aa172c675be6439eea202802a325a8c7348ed7766a39cd2b01c5cf57958fae58`; the rejected positive-case response SHA256 is `7fc71f730112437e50b86a77711775aff16864d5d9b7e5a0a854b136c4d22a00`. Both processes exited zero; measured wall times were 37,720 ms and 23,594 ms respectively. Exit zero is not review acceptance.

The positive source retains its original Qwen response lineage and source SHA256 `25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974`. Canonicalization is explicitly hashed separately; the earlier builder recovery input's incomplete provenance remains disclosed and is not repaired retroactively.

An independent configured review agent recomputed model/runtime/source/request/prompt/grammar/raw-response hashes and independently checked both numeric observations. It confirmed the partial outcome, not a formal product approval.

## Execution and authority boundaries
Only fixed public synthetic arithmetic was supplied. Expected classifications and prior model outcomes were host-hidden. Reviewer responses were never executed as code or commands. Witnesses were checked by a trusted AST interpreter and immutable six-case tests. All three verdicts (`defect`, `no_defect`, and `uncertain`) remained available. Reasons are AI assertions, not independently established facts.

Each child model process was limited to two threads, context 1,024, output 256 tokens, 180 seconds wall time, and a 4 GiB address-space cap. This cap does not include the Node orchestrator; peak RSS was not measured. Exact subprocess output and completeness metadata were retained privately. No private host paths or raw stderr are published here.

Default CI downloads or runs no model. No workflow was activated, no permission or secret changed, and no approval/release state was modified. This proves only measured advisory behavior on two tiny fixtures, not broad code-review quality, an integrated autonomous review gate, safe main integration, cross-run persistence, or 24-hour autonomy.

## Separate structural recovery observation
After independent design/code review and a new one-call authorization, only the previously rejected positive fixture was reviewed again. The generation grammar now requires a nonempty reason, and the parser rejects whitespace-only reasons without rewriting output. No expected classification, predecessor response, or witness answer was added to the unchanged candidate-and-requirement prompt. All three verdict choices remained possible.

- Exactly one fresh cached-model call, exit 0, wall time 12,991 ms; no retry or fallback.
- Output: `no_defect`; witness inputs -1 and -1, actual -2, required -2. Strict format and deterministic witness checks passed; the fixed six tests passed.
- The reason was the weak AI assertion `"defect" is not a valid verdict for this function.` This is **not** evidence of explanatory quality or security-review competence. Advisory agreement covers the bounded fixture and witness only.
- New separate receipt: 9,309 bytes, SHA256 `33c2efe5da9e32faefbcafbea4abf2d6b7ad909e830f53a306829572e419e53a`.
- Exact raw response SHA256 `8ec729f30a66f137e1d258a9e63a138a3df76cc26f2634811cb454609f14ae4b`.
- Prompt remained byte-identical to the rejected positive attempt: SHA256 `0c604e2691351ab9e4e068afb775947efa95d2138a844e55525518efd4b54be0`.
- Structural grammar SHA256 `cba5d543b1219dee0f97121c1b83b14971f26df35c7e240b481731f0200b9ac2`.
- The reviewed host contract pins the original receipt bytes/hash and empty-reason failure; that predecessor does not enter the prompt. The new receipt links it without upgrading or copying the original negative-case result.

Thus the initial pair remains one accepted advisory plus one rejection; a separate one-case recovery produced one bounded advisory agreement. This is not a new passing two-case run. No additional model executions are authorized by this evidence.

## Verification status
Independent implementation review reproduced 19 focused tests and 208 full tests before recovery. These deterministic tests use explicitly unverified test seams and launch no live model. Independent recovery-evidence review recomputed the original/new receipt, model/runtime, source, request, prompt, grammar, and raw-response hashes, confirmed the unchanged prompt and predecessor link, and independently reproduced the positive six-test and numeric-witness results. It accepted the evidence of bounded advisory agreement, not substantive correctness or release authority. No main merge or operational approval is implied.

### Official sources
- [Reviewer publisher and pinned artifact](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/tree/2d4a76a30b4af41ecd395c35725ac11688d4cfe4)
- [Official llama.cpp b11968 release](https://github.com/ggml-org/llama.cpp/releases/tag/b11968)
- [Pinned upstream JSON-string grammar](https://github.com/ggml-org/llama.cpp/blob/ac8e1694d837b11ed0aab944a6a2eee34b9c4d80/grammars/json.gbnf)
