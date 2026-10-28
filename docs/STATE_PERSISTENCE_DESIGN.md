# Cross-run state persistence design (not yet deployed)

The local job-state JSON and state-lease modules are deterministic prototypes, not a shared transactional store.

Proposed durable authority: dedicated private state repository or owner-controlled private database, isolated from public code and logs. Never put personal state, raw prompts, API keys or review receipts in the public repo.

Atomic transaction must check job revision, lease epoch, holder, expiry and idempotency key together; then append an event and update state in one operation. A stale worker must not write after lease expiry. GitHub Actions concurrency groups alone do not guarantee transactional compare-and-swap or prevent external writers.

Before activation: select storage provider and verify actual zero incremental cost, authentication, encryption, retention, backup/recovery, concurrency behavior, and permissions. Provisioning a private service, credential scopes or a new paid resource requires appropriate owner gate.

E2E acceptance: two concurrent runners contend for same job; exactly one commits. Terminate active runner, resume next run from durable checkpoint, reject stale writer, verify event chain, and demonstrate no secret/public log leakage. No completion claims without observed tests.
