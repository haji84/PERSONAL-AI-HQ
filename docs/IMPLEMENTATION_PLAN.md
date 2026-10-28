# Implementation plan and gates

Milestone 0: Public-safe repo. Acceptance: secret scan, synthetic-only fixtures, minimal CI permissions, threat model, zero exposed secrets.
Milestone 1: Local prototype. Acceptance: authenticated mobile UI, persisted tasks, schema migrations, role checks, no external side effects.
Milestone 2: Orchestration. Acceptance: idempotency, retry caps, crash recovery, deadlines, safe-stop, approvals tested.
Milestone 3: GitHub read-only adapter. Acceptance: scoped token, sanitized metadata, mocked and real read-only E2E, no secret logging.
Milestone 4: Independent verification. Acceptance: separate model/runtime evidence, SHA coverage, falsifiable completion criteria.
Milestone 5: iPhone E2E and operations. Acceptance: owner login, approval gates, restore, monitoring, budget and failure drills.
Milestone 6: Research/admin/life/creative adapters. Acceptance: consent, per-source privacy boundaries, task-specific tests.

All milestones must use draft PRs, independent design/code review, explicit human approval for critical changes, and evidence-based completion. No autonomous production deployment.
