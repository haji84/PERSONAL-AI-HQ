# PR 11 optional local builder — evidence draft

Status: local synthetic repair observed; independent evidence recheck passed. No operational activation. No model weights/binaries, private inputs or raw host stderr belong in this report.

## Measured capability
On 2026-10-28 a genuine local CPU inference using official llama.cpp b11968 and official Qwen2.5-Coder-0.5B-Instruct Q4_K_M produced a Python addition function. Exit 0; 1.681 seconds; peak child RSS 585,864 KiB. No API key, paid endpoint, server or generated-code execution in that first probe. This proves local model startup/code text generation only.

Runtime: ggml-org/llama.cpp, commit ac8e1694d837b11ed0aab944a6a2eee34b9c4d80, MIT. Runtime archive SHA256 6f9e44cafe6d185e993741de35e2b24a2333132f980dadb378b09ded78a19f2f. Model: Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF, revision ebb2015119c907b064c512bf053e945850b5875f, Apache-2.0; model SHA256 1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32. The optional reviewed profile binds all bundled libraries and symlink chains; host system libraries remain trusted dependencies, not a hermetic environment.

## Honest attempt history
1. Strict JSON parsing failed. Initial raw response was not retained, so exact cause is unknown; not successful repair.
2. Diagnostic-only attempt retained the full response: runtime EOG trailer and model-copied illustrative placeholder; no generated code executed. Pinned upstream confirmed that disabling logs also suppresses generated tokens, so that route was rejected.
3. Supported generation stop plus placeholder removal produced a correct-looking candidate in pretty JSON, but stop framing did not match and strict parsing failed. Candidate was not applied/tested; not successful repair.
4. Fixed-envelope GBNF preserved general model-generated JSON-string content, passed format and AST gates, then actual arithmetic retest failed. Original model receipt was lost by a host failure-propagation defect. A separately recovered candidate reproduced the subtract bug; independent reviewer verified both failing candidate and passing hand-authored control. This recovery is not full original model provenance.

These failures drove TDD fixes: complete bounded failure envelopes, explicit capture completeness and prefix hashes, fixed framing without output salvage, strict arithmetic-only AST, immutable tests, current-candidate recovery with at most two calls and format-insensitive AST-repeat stop. No hardcoded model answer or fabricated fallback is allowed.

## Observed bounded recovery

2026-10-28T19:29:51Z: using the reviewed frozen source, the recovered subtraction candidate failed the real immutable test (`add(2, 3): expected 5, got -1`). One actual local model call (3,780 ms, exit 0) generated `def add(a,b): return a + b`. The unchanged strict JSON/path/base contract, arithmetic AST gate and six real Python test cases passed. The second permitted call was not used. No response rewriting, answer fallback or model-supplied tests were involved.

The independent reviewer recomputed request, prompt, grammar, raw-response, proposal, source, runtime and model hashes, then independently reran the baseline assertion failure and repaired six-test pass.

The new recovery receipt retains `inputProvenance.complete: false`: earlier attempt 4's lost model receipt was not reconstructed. This run's model response, candidate, checker, tests and source hashes were measured separately. The generic orchestration receipt does not itself confer an independent-review attestation; actual model launch/output counts are recorded distinctly (one each).

| Evidence identity | SHA256 |
|---|---|
| Raw model response bytes | `6caa3c55f5ed5bc1ccedaa1cee83f866952ee508f271e9887ac895d7621360a0` |
| Generated and applied source | `25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974` |
| Immutable arithmetic cases | `f0088dc4e91c70eb811ecc44725e2366ea0f65fd616db9aae3e2bfb72b51d536` |
| Trusted Python checker | `9f190cdcaa956209c83b7d2e050d7fa52c94fd7ad5fbde60599168a54c5f1d5a` |
| Adapter source | `da55a6b54c7432e07924365f7a16e48975bb698f943feb36036052b080d1c28f` |
| Proof/recovery runner source | `7beb7284f550073e5fc957073e4d2b3dfdf8cb964749d5d5e91383209e3994ec` |
| Existing builder contract | `6a17a256b0b5a60e474fcbc16205c7ead694069974f813176547320ca16cb2b3` |
| Structural grammar | `12ffc02d40b7af580bca921039047333f74358762331b1ef694251de42096cdb` |
| Actual public synthetic prompt | `714f60596321d35c9ce6506b0fc4e35841805af0078cc5fa292c3a42ea06079b` |

Execution bounds: 2 CPU threads, 1,024-token context, at most 256 output tokens, 180 seconds per model process, 100 KiB combined process output. Generated Python is limited to the documented AST whitelist with 2-second CPU, 128 MiB address-space and 5-second external timeout. Test-run Python was 3.13.5; full-suite Node was 24.22.1. Base repository HEAD was 70321aa4a3290073f327ede30949559fca4697a2 with reviewed uncommitted model files (`dirty: true`), explicitly bound by the source hashes above—not falsely identified by HEAD alone.

## Verification scope and limitations
Frozen baseline 70321aa4a3290073f327ede30949559fca4697a2 plus explicit model-owned files passes 140 tests; the independent reviewer separately reproduced 29 focused and all 140 tests. A shared working-tree run temporarily included another worker’s unfinished OIDC-bootstrap RED tests; the isolated snapshot excluded those unrelated uncommitted files rather than hiding or deleting them. Default tests use labeled fake builders only where needed and never download/start a model. Actual inference is explicit local opt-in with preverified cached artifacts. No workflow activation, remote resources, permission changes, merge or repository autonomous writes were enabled.

A local synthetic proof is not separate-model review, security-gate acceptance, production sandboxing, cross-Actions persistence, next-Issue dispatch or a 24-hour autonomous-development completion claim. Any recovered-input provenance gap remains visible even if later tests pass.

## Primary sources
- https://github.com/ggml-org/llama.cpp/releases/tag/b11968
- https://github.com/ggml-org/llama.cpp/blob/ac8e1694d837b11ed0aab944a6a2eee34b9c4d80/tools/completion/completion.cpp
- https://github.com/ggml-org/llama.cpp/blob/ac8e1694d837b11ed0aab944a6a2eee34b9c4d80/grammars/json.gbnf
- https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF
