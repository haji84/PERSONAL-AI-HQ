# PR 11 preflight and bounded lease-validation repair

## Source and scope
- Baseline: `6c1051d70fefada3d17b3b60f8cb576b5cd2f3cc`.
- Existing branch: `feature/autonomous-manager-bootstrap`; no new PR.
- Common protocol read in full: `haji84/AI-/AGENTS.md`, blob `af561227e201dc721b617eab56f7cacdd4ad98d6`.
- Goal: safer lease contract and actual PR test execution. This slice does not implement a distributed state store or a production autonomous builder.
- Scope: lease validation, its regression tests, and the existing read-only workflow's PR trigger/test inclusion.

## Preflight observations
- Repository reads and pinned clone succeeded.
- At baseline, Actions returned zero runs for this HEAD, commit statuses were empty, and the only check was CodeRabbit `123006552638` with conclusion `skipped`. Formal review submissions were empty.
- Existing workflow had dispatch/schedule triggers only and was absent from main. Merely writing a cron expression did not prove scheduled execution.
- Baseline local tests: 14 passed on Node v24.22.1. Workflow targets Node 22; remote execution remains to be observed after publication.
- No operational model adapter, private shared store, signed approval authority, next-Issue dispatcher, or 24-hour E2E proof exists in this slice.
- PR 9 / Issue 1 independent security validation remains required before enabling autonomous writes.

## Reproduced failure and repair
- Lease assertions accepted invalid/missing clock values; malformed stored lease fields could match invalid request fields.
- Strict validation now rejects invalid holder, epoch, time, expiry and TTL, including expired boundaries, unsafe epoch increment and expiry arithmetic that does not advance time.
- Initial creation retains null/undefined absence semantics. An omitted expected epoch is accepted; a supplied expected epoch must be a positive safe integer. A valid supplied epoch remains ignored when no state exists for compatibility, not as a distributed CAS guarantee.
- Initial focused RED: 44 tests, 38 failed and 6 passed. Initial repaired focused GREEN: 44 passed.
- Separate review identified supplied-epoch validation missing for absent state. Added test RED: 1 failed / 45 passed; fixed focused GREEN: 46 passed.
- New static workflow-contract test was RED before the PR trigger/test-glob change, then passed.
- Final local whole-suite result: 58 passed, 0 failed on Node v24.22.1.
- `git diff --check` passed. PR 9's scanner from `1fc8b98ac5211301620434353f2aa8e4bb9dbb8d` passed staged candidate files. It is heuristic detection, not proof of absence or independent security approval.

## Review and evidence limits
- Design and code critique used a separate agent configured as `gpt-6-astra`; this is orchestration-level model selection evidence, not a provider-attested identity or integrated product reviewer receipt.
- No GitHub formal APPROVE is claimed.
- Static workflow checks do not prove YAML interpretation or runtime safety; observed GitHub execution is still required.
- Pull-request checkout may test a synthetic merge commit. Record that revision separately from source HEAD and base SHA when interpreting CI.
- This branch retains a cron trigger, but no merge or schedule activation has been performed. Eventual merge requires separate gate evaluation because it would activate the schedule.
- No credentials, workflow write permissions, model calls, paid resources, main changes or deployment were added by this repair.

## Remaining work
Private transactional state selection and authorization; atomic revision/epoch/idempotency commits; real cross-run contention and restart evidence; eligible actual coding-model execution; test-failure repair loop; independently verifiable review; protected merge; next-Issue continuation; 24-hour E2E.
