# Immutable secret guard repair (Issue #1 / PR #9)

Authorized scope: repair the existing PR branch, test with synthetic values and preserve honest evidence. No merge, deployment, credentials, permission changes or autonomous-write activation.

## Approach
The owner selected a reviewed fixed scanner operating on immutable Git data. Merely reordering candidate-controlled CI or pinning a SHA inside its editable workflow does not establish trust. An externally supplied, independently reviewed scanner plus externally bound candidate SHA is the verification approach; repository CI remains informational until a separately authorized enforcement trust root exists.

## Design
- Snapshot the complete index with `git write-tree`; scan every entry including type changes, rejecting unresolved entries. This intentionally blocks preexisting unsafe staged content too.
- Default scan resolves HEAD once; explicit `--commit` requires full commit SHA. Enumerate its immutable tree, inspect blobs by OID, never read candidate working-tree paths.
- Disable replacement objects; bound metadata buffers, check blob sizes before loading, reject all modes except regular 100644/100755, NUL and invalid UTF-8, unsafe paths and supported credential patterns.
- NUL-delimited metadata handles unusual filenames; fatal filename decoding prevents silent substitution. Log paths/rule names only, never blob contents.
- Fix direct execution detection with URL decoding and realpath normalization of both entry paths, including symlink invocation. Unknown arguments/errors fail closed.
- Separate reviewed scanner execution from candidate tests; exact scanner hash and candidate SHA identify evidence. Neither agent assertion nor CI success proves separate-model identity or an enforced merge gate.

## Recovery and remaining gaps
Baseline head 1fc8b98ac5211301620434353f2aa8e4bb9dbb8d; base dd135fccbfa872ddbb3d082985b2cbf14d7ef56e. Roll back by reverting this repair commit on the same branch and rerunning checks; never represent the old vulnerabilities as safe. Heuristic detection cannot prove absence, prevent initial public push, detect all encoding/novel formats, or establish required checks/protection. Autonomous writes remain blocked on independently verified enforcement and review identity.
