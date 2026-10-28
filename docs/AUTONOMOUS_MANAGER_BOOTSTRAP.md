# Autonomous manager bootstrap

Status: prototype; not a 24/7 coding agent.

Architecture: GitHub Actions scheduler -> read-only task planner -> policy gate -> (future) authorized Codex executor -> CI -> independently verified review -> human gate -> merge.
No real Codex executor is connected. No GitHub write permissions or tokens are granted by this prototype.
Default spend 0 JPY. No deployment, public publishing, destructive changes, permissions/security changes or main merges without explicit approval.
The existing PR #9 and independent reviewer PR #4 remain Draft until their own gates pass.

Required next implementation: durable state, concurrency control, issue ingestion, safe Codex execution adapter with bounded retries and sandbox, independent reviewer with real-model evidence, exact-SHA merge gate, encrypted private evidence storage and recovery, and owner notifications.
Do not treat a scheduled workflow that runs synthetic planning as proof of autonomous development.
