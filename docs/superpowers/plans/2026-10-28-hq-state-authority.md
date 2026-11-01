# HQ local state authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a fail-closed, fenced, idempotent transactional authority locally without activating cloud resources.

**Architecture:** Fixed-operation Worker with injectable trusted authorization and fixed repository/goal scope. D1 conditional updates and nonce-guarded event/receipt writes execute in one atomic batch; all authorization defaults deny.

**Tech Stack:** JavaScript ES modules, Cloudflare D1 SQL, Node test runner, Miniflare 4.20260730.0/workerd local development dependency (resolved from npm; lock before implementation).

**Spec:** `docs/HQ_STATE_AUTHORITY_DESIGN.md`

## Global Constraints
- Local only: no deployment, account changes, credentials, remote SQL or other application's DB access.
- No raw secret/prompt/code storage or logs; no completed-job or merge authority.
- Default authorization denies; live auth configuration and Free-plan status remain unverified.
- Keep PR #11 existing branch; independent design/code review and secret scan before sanitized publication.

## Review Focus
- Zero-row conditional mutation must not insert event or receipt (Task 2).
- Duplicate idempotency keys across principal/body variants must not disclose or reapply outcomes (Task 2).
- SQL mutation-time expiry must reject stale writers even after request delays (Task 2).
- Lost response and process restart must preserve exact immutable receipt and no duplicate event (Task 3).
- Oversize/chunked/malformed inputs and missing authorization must fail before database access (Task 1).

### Task 1: Fixed input and authorization boundary
Files: create `workers/state-authority/worker.mjs`, `workers/state-authority/contract.mjs`; tests `tests/state-authority-contract.test.mjs`.
Interface: `createAuthorityWorker({authorize,repository,goal})` exposes `fetch(request,env)`; env.HQ_STATE is the D1 binding. `validateCommand(operation,body)` yields normalized fixed-key command or rejects.
- [ ] Write failing tests for missing/forged principal, scope mismatch, inspect output cap of 50, unknown operation/method, exact field/types/ranges, body cap including chunks; verify no DB call occurs.
- [ ] Run `node --test tests/state-authority-contract.test.mjs` and record RED.
- [ ] Implement bounded parsing, default deny, scoped identity, no-store generic errors; keep adapter unconfigured.
- [ ] Rerun focused tests and full existing tests; independently review before commit.

### Task 2: Atomic D1 state authority
Files: create `workers/state-authority/schema.sql`, `workers/state-authority/store.mjs`, `tests/state-authority-d1.test.mjs`; local dependency manifest/lock if runtime installation succeeds.
Interface: `executeCommand(db, principal, command)` returns immutable mutation receipt or typed conflict; inspect reads only authorized job metadata. All database clocks and mutations use bound D1 SQL.
- [ ] Add actual local-D1 RED tests for claim contention, exact expiry, epoch/revision exhaustion, stale holders/revisions, invalid transitions, no DONE or AWAITING_APPROVAL exit, state-preserving release/reclaim, renewal and all nonce dependent-write guards.
- [ ] Implement three tables and batch mutation + guarded event/receipt inserts with primary reads, exact replay and response-loss recovery.
- [ ] Add forced receipt/event failure tests demonstrating full rollback, changed-body/principal replay rejection, no-event zero-row cases, two-client simultaneous duplicate retries and same-key/different-principal or body races (all receipt-return paths revalidate).
- [ ] Run local D1 tests; distinguish runtime evidence from mocks and remote guarantees. Review before commit.

### Task 3: Restart evidence and safe handoff
Files: update `docs/evidence/PR11_PREFLIGHT_20261028.md` or new bounded local-authority evidence document; local-only runtime test fixture.
- [ ] Write and execute restart test across disposed/recreated Miniflare instances sharing only disposable local persistence; recover receipt/state, reject old fence after reclaim.
- [ ] Test delayed duplicate after subsequent mutation returns original receipt without extending lease or changing counters.
- [ ] Run all tests, staged secret scan, independent code review and exact-head publication; run read-only PR CI to terminal without deploying or granting permissions.
- [ ] Record observed runtime versions, RED/GREEN, tested SHA and remaining remote activation gates. No claim of cross-Actions or 24h completion.
