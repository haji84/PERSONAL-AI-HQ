# Different-model local reviewer proof — design for independent review

Status: design only. No model download/inference, dependency installation, workflow activation or publication authorized by this document.

## Goal and boundary
Demonstrate actual local advisory review using weights genuinely different from the Qwen builder, on exactly two public arithmetic fixtures. This is not acceptance of arbitrary PRs, a security review capability, a release gate, provider-attested identity or 24-hour autonomy. Same runtime/host is permitted and its common-mode risk must be explicit. Model output is untrusted evidence, never authority.

## Source and cost evidence (read-only, 2026-10-28)
Preferred: official `HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF`, public and ungated per unauthenticated model API. Publisher model card and base model card declare Apache-2.0. Dedicated base LICENSE path returned 404; preserve official model-card license declaration plus standard license rather than claim a separate license file was found.
- Revision `2d4a76a30b4af41ecd395c35725ac11688d4cfe4`
- File `smollm2-1.7b-instruct-q4_k_m.gguf`
- Size `1055609536` bytes
- LFS SHA256 `decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33`
- Official base config/tokenizer revision `31b70e2e869a7173562077fd711b654946d38674`: model_type llama, LlamaForCausalLM, no auto_map; ChatML system/user/assistant template.
- https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF
- https://huggingface.co/api/models/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF?blobs=true
- https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct

Reuse existing official MIT llama.cpp b11968 commit `ac8e1694d837b11ed0aab944a6a2eee34b9c4d80`, already hash verified. Its cached top-level manifest has 61 files/links; the original archive count of 62 includes its root directory. No new runtime download, installer, remote custom code or server. Compare full reviewer model hash and identity against builder Qwen2.5-Coder-0.5B-Instruct qwen2 family, SHA `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32`; reject equal model hash/family or missing provenance.

Alternative considered: official SmolLM2-360M-Instruct-GGUF Q8, revision `593b5a2e04c8f3e4ee880263f93e0bd2901ad47f`, size386404992, SHA `48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201`. It is smaller but likely weaker; 1.7B is preferred for this bounded critique probe. This is not an automatic fallback authorization.

License/download/local CPU require no new account, API key, subscription, credits, API request or owner-billable external inference. Existing execution-environment limits still apply. Current observed available memory8.6GiB/disk29GiB supports feasibility; estimated model RSS1.5–3GiB is not a measurement or guaranteed bound. No other model was found in the dedicated model cache; no claim of whole-machine inventory.

## Inputs and blind procedure
Use one explicit host-seeded subtraction fixture and the exact saved actual-Qwen repaired fixture, with hashes/provenance verified independently. Do not label them buggy/repaired in model inputs or filenames exposed to model. Separate fresh model processes/contexts, opaque source-hash identifiers, identical public requirement: `add(a,b) returns the sum of a and b`.

Prompt includes only the requirement, canonical AST-safe source, an opaque ID and output schema instructions. Do not include expected verdict, test outputs, counterexample answer, builder reasoning, example filled-out verdict, other reviewer output or corrected expression. The fact that two fixtures differ does not leak which response is expected; host expectations remain outside model context.

## Advisory schema and deterministic checks
Model selects an enum verdict `defect`, `no_defect` or `uncertain`, a bounded reason string, and a numeric example with a,b,actual,required. Structural GBNF fixes envelope only. It must not constrain verdict or numbers to the expected answer. Inputs a,b are bounded integers, -9..9; output numbers are bounded integers. Strict JSON parsing rejects extra keys, unknown verdict, invalid ranges or malformed UTF-8. Supported generation-time stop handles the fixed envelope; no regex extraction, trailer stripping or repaired JSON.

A trusted deterministic verifier checks the claimed actual value with the already accepted arithmetic AST, interpreted by explicit Name/Constant/Add/Sub/Mult evaluation, not eval and not reviewer-generated code. Required value is host-computed a+b. It separately reruns the immutable existing six tests. A `defect` advisory needs a truthful concrete mismatch witness. A `no_defect` advisory needs a truthful equal witness and all six tests passing: this means agreement on the bounded fixture, not universal correctness. `uncertain`, false numeric claims, missing evidence or contrary fixed tests are INCONCLUSIVE/FAIL, never permission to merge. Natural-language reason remains AI_ASSERTED and is not represented as deterministically verified.

Both fixture observations must be retained even if model judgments are disappointing. Classification accuracy is separately reported; starting a distinct model is not evidence of review competence. No output becomes a command, path, executable source, approval or trusted policy field.

## Execution bounds and failure policy
Initially at most two inference calls total, one per fixture, sequential. Two threads including prompt batch, context1024, output256 tokens, timeout180 seconds, aggregate output100KiB per process. No retries/fallback/model substitution or unlimited diagnostic runs. Stop or record negative result on invalid profile/hash/format/output/timeout; no hidden success. Existing byte-exact failure-envelope and capture-completeness rules apply. Model process offline, empty stdin, shell false, clean allowlisted environment, fixed trusted arguments, disposable cwd/home. No network APIs/server, secret/environment dumps or private source.

Required hard memory bound: trusted Python stdlib resource/exec wrapper with RLIMIT_AS4GiB before launching the pinned executable. No unmeasured claim that context bounds enforce RAM. Record enforced address-space cap, RSS unmeasured, and actual exit/time separately. Do not execute any reviewer response.

Download only after design/code review and parent clearance: one pinned official file, enforce exact size cap and verify SHA before load; retain license/model-card evidence. No automatic download in adapter or CI. No model artifacts in Git or Actions artifacts/cache.

## Evidence and file scope
Evidence records builder/reviewer repo+revision+architecture+weight hash, shared runtime digest, exact candidate/base/source hash, prompt/grammar/raw-byte digests, trusted checker/test/source hashes, timestamps, process launch/termination and output completeness. Bind current repo HEAD plus dirty/source hashes. Original recovered builder-input provenance gap remains visible; never relabel it as complete because reviewer ran. Public reports omit raw host stderr, paths and private machine details.

Proposed new files only: scripts/local-reviewer-adapter.mjs, scripts/synthetic-review-proof.mjs, tests/local-reviewer-adapter.test.mjs, tests/synthetic-review-proof.test.mjs, tests/fixtures/local-reviewer/manifest.json, docs/LOCAL_REVIEWER_DESIGN.md and sanitized evidence doc. Required owned helper files: scripts/local-model-limit.py and scripts/review-witness-check.py. Reuse existing bounded process/bundle verifier by import; do not change builder/state/auth/approval/package/workflows unless a separately reviewed necessity arises.

Before implementation select an isolated snapshot of the current parent-approved PR11 HEAD, not stale local hq-preflight HEAD70321 or disappeared /tmp snapshot. Same remote branch/PR only via sole publisher after root clearance; no publication during this proof.

## Acceptance plan
1. Independent design review, model/license/cost/privacy evidence and explicit parent clearance.
2. TDD for model identity distinction, manifest/byte/hash verification, cleanenv/fixed args, blind prompt/grammar (all verdicts and numeric results available), strict parsing, deterministic witness checks, deliberate false claims, unexpected model failure, immutable inputs/tests and no authority effects. Ordinary CI uses labeled test doubles, no inference/download.
3. Independent code review and full isolated-snapshot regression before official model download or actual calls.
4. Hash-check official model; exactly two fresh bounded calls or a documented earlier safety stop. Preserve raw observations and failures; never fill missing results with expected answers.
5. Independent receipt rehash/recheck and sanitized report. Mark only local distinct-model advisory roundtrip and separately measured fixture critique accuracy; operational review gate and full autonomy remain unproven.

## Independent design-review refinements (required)
Freeze before model calls the exact host-only expectation map: host-seeded source `def add(a, b):\n    return a - b\n`, SHA256 `e1a894022d1a082987b87adecb623438c9e386d86b2b621cff4a5fe7fdf7edc8`, expected defect; actual saved Qwen output `def add(a,b): return a + b`, SHA256 `25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974`, expected no_defect. Expectations and origin labels stay outside both prompts/grammars. Candidate IDs are opaque source hashes. Record both original and canonical input hashes if canonicalized; no label-derived ID or order.

All witness numbers must be finite safe integers; a,b in[-9,9], actual/required in[-18,18]. Separate fields modelExecuted, formatValid, witnessValid and caseAgreement; no final approval flag. Reason stays AI_ASSERTED. No_defect plus six tests only establishes bounded fixture agreement. Freeze/hash expectation map, fixture/oracle files, prompt/grammar/model/runtime/wrapper before inference; recheck frozen files and oracle before/after both processes. Distinct local artifacts/processes are not a claim of independent training/provider/security competence.

Hard RLIMIT_AS4GiB is required through a reviewed Python stdlib wrapper using os.execve (replaces process; no child/orphan). Cap refusal/failure is recorded without lifting limit or retry. Wrapper receives only host-selected executable/model arguments after profile/bundle checks and clears environment except the explicit runtime allowlist.

At most one process per fixture. A well-formed negative/uncertain/false model judgment is recorded and the other fixture may still be measured; invalid JSON is a model-format negative and may likewise leave the second independent fixture eligible. An infrastructure/resource/hash/integrity/decoder/output-overflow error stops remaining execution; record the second case as SKIPPED with exact cause, not success. No retry under either branch. Whole proof remains advisory.

Implementation baseline must be fresh verified official PR11 ref `0f0dc1f31432ff36e3e1f6d43295fe2b363fcbcd` (or parent-approved newer ref), isolated from concurrent work. Shared old70321 checkout is inspection only.

All THREE verdict alternatives defect/no_defect/uncertain remain grammar-accessible. Original positive-source SHA25b512…994974 identifies the saved Qwen bytes, not normalized prompt bytes. Preserve original response digest6caa3c55f5ed5bc1ccedaa1cee83f866952ee508f271e9887ac895d7621360a0 and deterministic original→canonical-source/AST identity link; retain earlier recovered-input provenance gap separately. The exec wrapper enforces address-space cap but does not claim exact peakRSS; use cap+RSS unmeasured unless an explicitly labeled sampled observation is available. No fork/wait sampler is required.

Injected/mock reviewer seams stay explicitly unverified. Only an explicit actual-run wrapper binds the real adapter/profile; model JSON cannot provide or overwrite model/runtime/process identity, advisoryOnly, authority or acceptance fields. Identity derives from host hash checks and fixed executable path, not a grammar-forced identity echo. No state/Issue/approval/release mutations are included. Proposed trusted helper paths are scripts/local-model-limit.py (resource limits + exec replacement) and scripts/review-witness-check.py (AST-only arithmetic interpretation, never executes reviewer output).

The 4GiB RLIMIT_AS applies only to the exec-replaced model process, not the Node orchestrator or the entire proof. The orchestrator currently hashes the 1.06GB weight file using readFile; whole-proof peak memory is unmeasured. No whole-system or physical-RAM cap is claimed.

## Single-case structural recovery — independent design approved, live pending
The original paired run remains immutable: two distinct-model executions, one accepted defect advisory, one schema-rejected positive response because reason was empty. Exact original private receipt bytes: 14636, SHA256 c801e1da3b1f51bb7237c2f0d1c8d62bca9fb26301db48a6be38d1173c5fa183. Positive raw-response SHA2567fc71f730112437e50b86a77711775aff16864d5d9b7e5a0a854b136c4d22a00.

A separate recovery may use at most ONE fresh call for only positive sourceSHA25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974. Tighten reason's structural grammar repetition from * to + and reject whitespace-only reason in the parser, without trimming/rewriting returned content. All verdicts/numeric alternatives remain available; prompt must remain exact SHA0c604e2691351ab9e4e068afb775947efa95d2138a844e55525518efd4b54be0. No predecessor verdict/reason/results/answer enters the model prompt.

A reviewed host predecessor contract pins full original bytes/hash, failed-case hash, exact emptyreason format rejection and prompt hash; a caller-provided self-hash is insufficient. Generic injected validation can be unit-tested with labeled synthetic contracts, but actual recovery hard-binds the reviewed contract. Host-only fixture selection rejects empty/unknown/duplicate selectors before invocation. The actual recovery wrapper always chooses the one failed fixture and max1, terminalizing only selected cases. New receipt links predecessor without copying the old accepted bug verdict into a claimed new paired success. Original paired failure remains unchanged. No retry if recovery is invalid/uncertain/false.

Prepare on isolated latest official8a8dfa11192ace235e692c07d4481034c2ca0fbb; preserve original d92 candidate and evidence. Independent code review, full tests and new root live clearance are mandatory before the single new call. No new model/download/budget increase or permission change.
