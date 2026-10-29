# Secret guard (Issue #1)

## Local setup and exact subject
Run `node scripts/install-hooks.mjs` once per clone (sets executable bit and hooksPath; verify output). Run all tests with `node --test tests/*.mjs`.

`node scripts/secret-guard.mjs --staged` snapshots the **complete index** with `git write-tree` and reads immutable blobs. It includes type changes and rejects unresolved merges; preexisting unsupported files also block a commit. The hook preserves Git's temporary `GIT_INDEX_FILE` for partial commits.

`node scripts/secret-guard.mjs` scans the committed HEAD, **not local edits**. `node /trusted/path/secret-guard.mjs --commit <full-commit-SHA>` scans that exact commit, ignoring working-tree edits, the current index and replacement refs. A safe HEAD does not imply safe unstaged files. Index snapshot creation writes local Git objects, not branch refs or staged content.

Only regular Git file modes 100644/100755 and valid UTF-8 text of at most 1 MiB without NUL are supported. Symlinks, gitlinks, invalid encodings, malformed metadata and Git errors fail closed. Paths are NUL-delimited; control characters are JSON-escaped in diagnostics. Matched values are never printed. Unknown CLI arguments fail closed.

## Verification trust boundary — unresolved enforcement
Repository CI is an **informational candidate-controlled self-check**, not trusted security enforcement. The workflow and scanner can both be edited by a candidate; moving a scan earlier or adding a scanner SHA pin inside that workflow does not create a trust root. Tests running before the scan cannot clean the committed blobs, but can still replace the local scanner itself. CI success must not authorize autonomous writes or main merge.

For independent evidence, an external reviewer must supply the audited scanner from outside the candidate checkout, authenticate its approved SHA-256 using an authority outside candidate-controlled files/arguments, bind the candidate full commit SHA, and run only that scanner against Git objects. It imports only Node built-ins, not candidate modules. Keep candidate test execution separate. Record scanner digest, subject SHA, tool/runtime identity, command and exit result. Copying a candidate file to another directory alone is NOT independent authentication. Such an external one-time audit still does not configure a required trusted gate.

Independently enforced workflow/check authority, protection/rulesets and separately verified reviewer model/runtime identity remain unestablished here. Issue #10 autonomous writes remain blocked; this repair is not an activation approval.

## Limitations
The hook is optional and can be bypassed. GitHub Actions runs after commits are pushed and CANNOT prevent initial public exposure. This scanner is heuristic and can miss encoded, split, multiline, unsupported or novel credentials and private data. This scan covers one tree, not all history, deleted historical files, artifacts, logs or LFS payloads. Passing does not prove absence of secrets. Use only synthetic public fixtures; do not push real private data. Review changes before pushing.

## Incident response
If a credential is committed, immediately revoke/rotate it with its issuer, disable affected automation, assess exposure, and coordinate Git history remediation. Deleting a file or commit does not guarantee removal from caches or forks.
