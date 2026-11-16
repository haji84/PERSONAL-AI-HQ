# PR #11: Qwen no-op gate and revised bounded prompt (2026-10-30)

Status: **CODE/CI VERIFIED; REAL INFERENCE UNTESTED AFTER CHANGES; AUTONOMOUS DEVELOPMENT NOT COMPLETE.**

## Diagnosed evidence and limits

Two previous one-shot, explicitly owner-approved public-synthetic Qwen experiments:
- [Run A 40916992079](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40916992079)
- [Run B 41011039193](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41011039193)

Both reported identical public synthetic candidate source digest `3803a0bed9badd513968af60e4b9b4ad1e47087d4f49c01b955f4133f18a22b3`. Independent SHA comparison matched `def add(a,b): return a - b`, the same Python arithmetic AST as the subtraction seed, although formatted differently. The original deterministic 0.5B Qwen implementation model did not produce the requested addition repair in those measurements. The **cause of the model's behavior is not proven**: model size/capability, prompt clarity and inference options are hypotheses, not verified diagnoses.

Before these changes, `parseSyntheticProposal` rejected only the literal original source string, and the recovery controller rejected repeated source only **after** immutable retest using an AST-plus-failure-text signature. A formatting-only response could reach the retest stage; the top-level builder summary discarded whether semantic AST had repeated. It correctly blocked reviewer execution but did not preserve the precise no-op classification for replay analysis.

## RED-to-GREEN observed in original existing PR #11

- RED [41019908772](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41019908772): 278 pass / 3 expected new failures (AST no-op flag + targeted prompt).
- Added a second non-subtraction prompt case. RED [41020143596](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41020143596): 280 pass / 2 new prompt failures; the AST implementation passed.
- GREEN [41020258159](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41020258159): 282/282 pass.
- RED [41020391014](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41020391014): 282 pass / 2 new failures in bridge/state no-op visibility.
- Final code GREEN, tested HEAD `967e792aa1a0f0074bc94ae6c32c242df0dd2564`, CI [41020502047](https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/41020502047): **284/284 pass, 0 fail, 0 skipped**.

Implementation:
- A repeated trusted AST hash now fails as `repeated-canonical-ast-failure` regardless of formatting or assertion wording, with `semanticNoOp: true`; it stops before another model invocation.
- Meaningfully changed failing candidates may still receive up to the existing two total bounded attempts, and a passing candidate is not marked a no-op.
- The bridge and local state persistence expose only `builderSemanticNoOp: true/false`, never the model's raw response or a release authority.
- Recovery instructions now directly explain the wrong subtraction operation, require an actual arithmetic change rather than merely changing formatting, and provide `add(-4, 3)=-1` as an additional public numeric requirement. A non-subtraction candidate gets accurate generic instructions. The prompt still does **not** provide a complete repaired source answer. The existing fixed six-case checker, AST whitelist, model/SHA pins, safety stop, and no-review-without-passing-tests remain unchanged.

**Caveat:** Equal AST hashes prove a repeated syntax tree, not arbitrary semantic equivalence of all programs. Distinct ASTs can implement the same arithmetic and are still subject to immutable test failure.

## Model selection review (NOT execution or authorization)

**Current:** pinned `Qwen2.5-Coder-0.5B-Instruct` Q4_K_M (~491 MB per project manifest), exact project SHA-256 `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32`. This is the model that twice produced an unchanged subtraction AST under the former prompt. The revised prompt has **not** been exercised with live model inference.

**Proposed alternative for a future approved one-shot:** the publisher's official `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF`, Q4_K_M (~1.12 GB), Apache-2.0, with file SHA-256 published by Hugging Face:
`cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046`.
Sources:
- https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/tree/main
- https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

This is a **candidate** only. No 1.5B model was downloaded, installed, checked against the pinned file hash, added to a live manifest or run by the autonomous controller. The model-size increase is a tradeoff: greater capacity is plausible, but correctness and runtime fit are unproven. Do not call this a successful selection. To proceed, freeze the exact publisher revision and file digest; create a separate verified candidate adapter/profile without rewriting the historical 0.5B evidence; confirm bounded memory/time and file integrity; obtain separate owner approval for one explicit read-only hosted-runner experiment and required independent design/security review. Do not silently switch the model.

## Next real-model acceptance (owner gate)

No paid models, keys, new workflows, cloud resources, GitHub write permission, main merge or public deployment are authorized here. A new bounded one-shot needs a new owner approval. It must produce, or explicitly fail closed without inventing:
- One real Qwen candidate with pinned model/runtime identity and exact source digest.
- Non-no-op trusted AST assessment and full immutable six-case retest PASS before invoking any reviewer.
- At most one distinct SmolLM2 reviewer invocation on the **exact** generated candidate, with its own model/source hashes, bounded verdict, and no unilateral approval.
- Verified local checkpoint and separate-process restart as defined by the existing controller. **This does not establish authenticated remote store or across-GitHub-Actions persistence.**
- Temporary workflow/helper removal, original inventory CI restored, no public model raw-output/GPS/secret artifacts.

PR #9 independent security review, authenticated cross-run state and autonomous next-task dispatch remain **BLOCKED**, not waived by a single successful two-model synthetic test.
