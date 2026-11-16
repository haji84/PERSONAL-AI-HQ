# PERSONAL AI HQ — GOAL v1.0 (proposed)

Status: DESIGN / NOT PRODUCTION READY

## Mission
Provide a single owner-controlled headquarters to plan, delegate, observe, validate, and approve AI-assisted work across software development, research, administration, personal scheduling, and creative production.

## Non-negotiable acceptance criteria
1. iPhone-friendly authenticated dashboard lists projects, tasks, verified outcomes, costs, blockers, and approvals.
2. Task lifecycle is auditable: proposed -> approved (when required) -> queued -> running -> verifying -> done/blocked.
3. Each task has a goal, measurable acceptance tests, owner, budget, permitted tools, timeout, retry limit, and evidence links.
4. Execution is deny-by-default for unconfigured connectors and unsafe actions.
5. An independent validation route checks actual evidence; AI self-report cannot mark tasks complete.
6. External publication, spending, permission changes, destructive operations, and root architecture changes require explicit owner approval.
7. Public repository must contain NO personal records, credentials, secrets, private source content, or confidential execution logs.
8. Integrations (GitHub, Codex, Google tools, optional Dots/Work) use documented APIs and least-privilege scopes; no assumed interoperability.
9. Actual device end-to-end tests and security tests are required before production use.
10. Default incremental spend budget: 0 JPY; no paid resource provisioning without owner approval.

## Out of scope for initial milestone
Autonomous payments, unattended external publishing, production account administration, storage of private user records in GitHub, and unattended merges to protected main.

## Completion evidence
A requirement is DONE only with linked reproducible tests, artifacts, independent review, and real-device evidence where applicable. CI green alone is insufficient.

## Autonomous-development acceptance supplement
The final autonomous-development goal extends (not replaces) the initial dashboard milestone: continuous, provider/model/device-independent development from issue selection through implementation, test-failure diagnosis and repair, separate-model review, authorized integration and next-issue continuation.

Completion requires observed evidence that (1) an Issue is selected automatically, (2) a real AI writes code, (3) failing tests are detected, (4) AI repairs the code, (5) tests subsequently pass, (6) a different model independently reviews it, (7) only approved and verified changes integrate, (8) the next Issue starts automatically, (9) state survives distinct Actions runs, and (10) interrupted work resumes safely. A 24-hour E2E exercises these capabilities; green CI or synthetic fixtures alone do not establish completion.

No model or host is mandatory. Existing publication, cost, permissions, security and protected-main approval gates remain binding. No unattended deployment, credential setup or main merge authority is granted by this supplement.
