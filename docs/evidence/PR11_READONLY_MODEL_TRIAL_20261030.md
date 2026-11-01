# PR #11 read-only real-model trial and safety cleanup (2026-10-30 JST)

## Observed one-shot execution
- GitHub Actions run: https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40904873322
- Job ID: `123556772822`; **conclusion FAILURE** (do not label the two-model end-to-end flow successful).
- Before the model step, the job logged `PINNED_PUBLIC_ARTIFACTS_VERIFIED`: the version-pinned llama.cpp b11968 Ubuntu x64 archive, Qwen2.5-Coder 0.5B Q4_K_M and SmolLM2 1.7B Q4_K_M files all passed the SHA-256/size validation step.
- Measured job output: `builderObserved=true`, `reviewerObserved=false`, `state=BLOCKED`, `releaseGate=NOT_AUTHORIZED`, `nextTaskDispatched=false`, `remoteCheckpointVerified=false`. The host recorded actual bounded Qwen model completion; **no accepted SmolLM2 model review** was observed.
- The job exited 2. The public summary omitted the exact reason and candidate source hash, so it is **not currently established** whether the reviewer was skipped for unsupported source formatting or was invoked but failed. Avoid guessing or reclassifying the missing evidence.
- No model binaries or raw outputs were committed or uploaded as Actions artifacts; the read-only task used only a fixed public synthetic arithmetic fixture. No API key, GitHub write, paid model endpoint or user GPS data was supplied.

## Existing security contract discovered and restored
- The experimental workflow `.github/workflows/model-probe-readonly.yml` violated the existing `tests/oidc-bootstrap-proof.test.mjs` safety inventory, which permits only `autonomous-manager-plan.yml`. The ordinary planning CI run https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40904873158 failed **one inventory test** as it should.
- The temporary workflow was removed on the existing PR #11 branch in commit `8362b465d1a548ba7fa7f29382cb3faacbace5fa` rather than weakening the protected inventory test.
- After removal, the exact-HEAD planning CI https://github.com/haji84/PERSONAL-AI-HQ/actions/runs/40905291242 passed. Do not reinstate a model-download workflow without an appropriate independently reviewed design and explicit approval for the security-policy change.

## Remaining gates
- Add validated non-sensitive diagnostics (source SHA, bounded failure stage, review status) to distinguish the Qwen-only outcome before another model attempt.
- Pin a genuine different-model SmolLM2 response to the exact generated source, validate it with immutable tests and retain independent receipt hashes. A matching arithmetic response alone is not security review approval.
- Establish independently verified PR #9 protection before granting autonomous GitHub write authority.
- Prove transactional checkpoints and lease fencing across separate Actions executions; no remote state or automatic next-task dispatch has been authorized.
- Preserve BLOCKED for main merge, paid resources, privileged permission changes and publication.

This is a factual trial report, NOT a claim of independent security review or completed autonomous development.
