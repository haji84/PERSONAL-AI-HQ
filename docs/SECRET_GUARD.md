# Secret guard (Issue #1)

## Local setup
Run `node scripts/install-hooks.mjs` once per clone (sets executable bit and hooksPath; verify output), then `node --test tests/secret-guard.test.mjs` and `node scripts/secret-guard.mjs`.

## Limitations
The pre-commit hook is optional unless locally installed. GitHub Actions runs after commits have been pushed, so it CANNOT prevent a secret from first reaching the public repository. The scanner is heuristic, can miss secrets, and rejects unknown binary or files over 1 MiB. Public PR diffs and Actions logs are public. Avoid pushing any real private data; use a separate local private runtime. Review changes manually before pushing. Never print matched values in logs. Repository rulesets/branch protections and independent review still need setup and verification.

## Incident response
If a credential is committed, immediately revoke/rotate it with its issuer, disable affected automation, assess exposure, and coordinate Git history remediation. Deleting a file or commit does not guarantee removal from caches or forks.
