# Architecture v0.1 — proposal

## Trust boundaries
- Public GitHub: source code, sanitized specifications, synthetic test fixtures only.
- Owner-controlled private runtime: credentials, tokens, personal content, execution logs, encryption keys.
- Browser: authenticated owner UI; no embedded credentials.
- Connectors: explicit allowlist, scoped permissions, budget, timeout, rate limits, human gates.

## Components
1. Dashboard (mobile-first): project portfolio, tasks, evidence, approvals, costs.
2. Orchestrator: durable task state machine, idempotent dispatch, bounded retries, stop conditions.
3. Adapters: GitHub, local Codex, Google services, optional Work/Dots where documented and permitted.
4. Policy engine: classify actions; deny risky actions without signed/recorded approval.
5. Evidence service: immutable identifiers, SHA-256 digests, provenance, independently checked completion.
6. Secret broker: runtime-only retrieval; never write values to source, artifacts, prompts, or logs.
7. Audit service: private retention, redaction, append-only events, export and deletion policies.

## Approval policy
Require explicit owner approval before spending, public deployment, destructive data operations, privilege changes, security-policy changes, root GOAL changes, or protected-main merges.

## Deployment decisions pending
Select authenticated runtime, private storage, mobile access method, and hosting after cost and threat-model review. No cloud resources created by this document.

## Implementation sequence
P0 threat model and public repository guards; P1 local dashboard and durable task ledger; P2 human-gate and evidence tests; P3 first read-only GitHub adapter; P4 independent validation; P5 iPhone E2E; P6 other departments.
