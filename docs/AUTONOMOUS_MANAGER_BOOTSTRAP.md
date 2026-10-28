# Autonomous manager bootstrap

Status: prototype; not a 24/7 coding agent.

Architecture: GitHub Actions scheduler -> read-only task planner -> policy gate -> (future) authorized interchangeable coding-model executor -> CI -> independently verified review -> human gate -> merge.
No real coding-model executor is connected. Codex is optional, not required. No GitHub write permissions or tokens are granted by this prototype.
Default spend 0 JPY. No deployment, public publishing, destructive changes, permissions/security changes or main merges without explicit approval.
The existing PR #9 and independent reviewer PR #4 remain Draft until their own gates pass.

Required next implementation: durable state, concurrency control, issue ingestion, safe Codex execution adapter with bounded retries and sandbox, independent reviewer with real-model evidence, exact-SHA merge gate, encrypted private evidence storage and recovery, and owner notifications.
Do not treat a scheduled workflow that runs synthetic planning as proof of autonomous development.

## Model-neutral execution policy
Provider adapters must expose capability discovery, availability, budget estimate, timeout, and evidence fields. Selection must fail closed if no eligible provider is available. Gemini free-tier access is not an unlimited execution guarantee. Ollama requires an active host. Codex is an optional adapter only. Implementing and reviewing code must use independently verified execution identities. No silent provider fallback that changes data handling, privacy or cost.
