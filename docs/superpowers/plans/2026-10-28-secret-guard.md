# Secret Guard Repair Implementation Plan

> **For agentic workers:** Execute natively under the assigned independent design/code reviewer.

**Goal:** Close reproduced scanner bypasses without claiming a trusted autonomous gate.
**Architecture:** Immutable Git tree/blob snapshots; externally reviewed scanner source and exact candidate identity.
**Tech Stack:** Node built-ins and Git, no dependencies.
**Spec:** ../specs/2026-10-28-secret-guard-design.md

## Global Constraints
No secrets, new privileges, merge, deployment, paid service, or unrelated edits. Synthetic tests only.

## Review Focus
Type changes; unusual checkout/filenames; mutable working trees; malformed encodings; unsupported tree modes and replacement refs.

## Task 1: Regression evidence
- [x] Add actual Git CLI tests for the five demonstrated bypasses, staging/committed mismatches, modes, malformed UTF8, oversize, missing objects, unknown args and full-SHA binding.
- [x] Run against original scanner and preserve failing test output (expected assertions, not setup errors).
## Task 2: Repair
- [x] Replace path reads with tree enumeration and OID blob reads in scripts/secret-guard.mjs; strict modes, encoding, CLI.
- [ ] Run node --test tests/*.mjs (all tests), scanner on immutable candidate and independent external harness.
## Task 3: Evidence and review
- [x] Document semantics and unresolved trust root; CI explicitly informational, add regression tests.
- [ ] Freeze scanner SHA256 and commit; independent code review on exact commit.
- [ ] Obtain parent publication confirmation; publish existing branch only and observe terminal CI, re-review any corrections.
