# PERSONAL AI HQ common autonomous development protocol

Source references (read-only, do not blindly copy code):
- haji84/AI-/AGENTS.md (JARVIS Autonomous Development Protocol v1.0-RC2)
- haji84/AI-/docs/runbooks/human-gates.md
- haji84/AI-/docs/superpowers/specs/2026-09-26-goriq-offline-self-development-design.md

## Governing principles
1. Single GOAL authority, deduplicated intake. Chat, GitHub, Codex, Gemini, Ollama are capabilities, not competing authorities.
2. Before work: read GOAL, PROJECT_STATE, roadmap, assigned Issue, design and decisions. Lock requirements, acceptance, non-goals, risk, budgets, current HEAD and baseline snapshot.
3. Independent design review before non-trivial implementation. Review must be genuine, separate from builder and evidence-backed.
4. Decompose into small reversible jobs, with explicit dependencies and safe parallelism. Prevent simultaneous writes to same work item.
5. TDD where applicable: failing acceptance test, minimal implementation, focused tests and affected regressions.
6. Builders are model-neutral and have no merge, production, credential, billing or permission authority.
7. Durable state controller owns transitions, append-only attempt history, checkpoints, idempotency keys, failure signatures and evidence.
8. On failure: diagnose, distinguish repeated failed strategy, replan or switch eligible capability within privacy/cost bounds. Never silently infinite-loop.
9. Independent verifier checks exact SHA, affected scope, CI, security, runtime and physical-device evidence as applicable. AI_ASSERTED is not machine evidence. INCONCLUSIVE is not PASS.
10. Release gate checks current HEAD, review independence, CI, protection, approval scope, and evidence before merge. Post-merge CI and runtime verification remain required.
11. Human Gate: secrets, permission/security policy, billing, destructive operations, major publication, GOAL/architecture changes and other critical actions need explicit owner approval. No auto-expansion of authorization.
12. Zero incremental spend by default; no paid API activation, automatic overage, or external data transfer beyond approved scope.
13. Public repo contains only public-safe source and synthetic evidence; private content and secrets stay in a separately controlled runtime.
14. When no safe action remains, persist BLOCKED with precise cause and next required authority/capability. Do not fabricate progress.

## PERSONAL AI HQ adaptation
- PR #9 security gate and independent reviewer PR #4 remain separate Draft gates; no merge without validated independent review.
- PR #11 is the autonomous manager prototype, not yet a real coding loop.
- Target execution loop: Issue -> goal resolution -> approved job -> model-neutral builder -> isolated change set -> CI -> independent verifier -> release gate -> next Issue.
- Use GitHub Actions as bounded scheduler/CI, not as proof of 24/7 inference. Model availability and actual runtime must be observed.
- State and authorization are durable and verified; never trust boolean approval supplied by a task or AI output.
- Require real E2E proof: model generates code, tests run, fix/retry on failing test, independent reviewer response, exact-SHA gate, and continuation to next task.
