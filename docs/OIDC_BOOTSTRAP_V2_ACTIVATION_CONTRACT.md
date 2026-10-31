# Future v2 activation and cleanup contract — inactive

These artifacts prepare a specific future approval request. They do not authorize another run, install a workflow, grant permissions or apply either test patch. The consumed v1 attempt remains historical; no v1 retry is proposed.

## Exact fixed candidate

- Repository/PR: `haji84/PERSONAL-AI-HQ`, PR11; head branch `feature/autonomous-manager-bootstrap`, base `main`.
- Eventual active path: `.github/workflows/hq-oidc-bootstrap-pr11-v2.yml`.
- Inactive template: `templates/oidc-bootstrap-v2.yml.example`.
- Template / eventual active-byte SHA-256: `22d8d1a19f11714d3dc89295348b18ee41c299c658b22c945340b9a5bc95f490`.
- Reviewed diagnostic source commit: `d92d452f6a3beb0f9ae10c1ac7d1083720f86308`.
- Diagnostic source SHA-256: `b5ec2cae53940b151d82e0e273fc5a4f24d8f02445364427d18c241d1d8dff4c`; matching lock `e916fdf8a7cb83062ec8a11b30cd6bc45ddde4df59c4fa79628894ec6be987eb`; manifest `3a4614679461b159207434356aa5c71a9940186f6b2371b707eca83d6b48268e`.
- Existing read-only workflow bytes stay SHA-256 `5dab11b6e988c9d3313c4725588263c6e31ca074c94fe3143fa529d135c7f974`.

Source/lock/manifest were read directly from that public GitHub commit and matched reviewed bytes. Source-stage ordinary CI 40771462026 passed 189/189 on Node 22.23.4. No active v2 workflow was installed for that test.

## Runtime scope for a future explicit approval

Only one same-repository PR11 synchronize job, run_number=1 AND run_attempt=1, may execute. Job-only permissions are contents:read and id-token:write; top-level permissions remain empty. Exact repository/owner IDs, branch/ref, hosted-Linux runner, source/workflow identity and job identity checks remain fixed. The v2 audience is exactly `urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v2`, prohibited by state authorization's reserved namespace.

There is at most one bounded mint request and one fixed GitHub JWKS request, with no retry/redirect/fallback. All prior cryptographic, subject, optional-claim and 600-second lifetime/age checks remain. Failure output is only `OIDC_BOOTSTRAP_FAILED stage=<fixed-enum> field=<fixed-enum>`; no values, token, URL, credentials, full claims or error object. Success remains exactly the eleven validated public proof fields. Diagnostic stages report only the first detected failure, not all possible mismatches or proof that later checks passed. They are not token-issuance proof and cannot retrospectively establish why v1 failed. An unknown/failed result does not authorize another attempt or weaker checks.

The active workflow path/history must be unused before any future installation; unexpected counters stop rather than resetting or reusing another path. The exact template/source/test transitions and temporary permission must be presented for separate user approval before publication of an activation commit.

## Exact future test patches

Both `.patch.example` files are inert and modify only the two test files below, never the verifier or historical v1 template/patch artifacts. The activation patch temporarily changes v1's cleanup inventory guard explicitly: v1 must still be absent and the only allowed active inventory is unchanged read-only workflow plus exact hash-bound v2. The v2 test independently enforces that inventory, non-symlink regular files, byte-identical template/active file and unchanged read-only hash. No wildcard or conditional auto-allow is introduced.

- Activation patch `templates/oidc-bootstrap-v2-activation-tests.patch.example`: SHA-256 `21598512bb05c54351f8924cb59a9701efc07f9cce2ec03d18e1d220c60363c3`.
- Cleanup patch `templates/oidc-bootstrap-v2-cleanup-tests.patch.example`: SHA-256 `1aa751ef1f7d53aabf1747f35cc6878d2905788290857ee4e345646d89fac472`.

`tests/oidc-bootstrap-proof.test.mjs`:
- Inactive preimage: `69a8c65505d3f1d52ab6de7ffa6be5557419f6ce2308d208e3c1ac25722f9c11`.
- Active postimage / cleanup preimage: `fba2dcfa1f853228664feecee8492918c96034d9b82f6dcc2b6075bdea479f73`.
- Exact restored cleanup postimage: `69a8c65505d3f1d52ab6de7ffa6be5557419f6ce2308d208e3c1ac25722f9c11`.

`tests/oidc-bootstrap-diagnostic.test.mjs`:
- Inactive preimage: `2b4ba2ec1629189781c9066600735f550539d1f2a000aa11f43fe1365381416e`.
- Active postimage / cleanup preimage: `98f9b45eaea4613e4e737babc0d0671acac82675d2a2905afd8e33128aea4d13`.
- Exact restored cleanup postimage: `2b4ba2ec1629189781c9066600735f550539d1f2a000aa11f43fe1365381416e`.

The future activation commit would install only the exact template bytes and apply the reviewed activation patch together. After one terminal success, failure or unknown outcome, the approved cleanup would remove v2 and apply the cleanup patch together. Cleanup restores both test files byte-for-byte to their reviewed inactive forms, requires exactly the single read-only workflow, and separately rejects both v1 and v2 active paths. The v1 test is restored exactly to its prior cleanup hash 69a8c655…; its temporary v2-aware inventory transition is explicit, not a silent deletion of a guard.

Removing the workflow/permission does not revoke an already issued token, erase history or prove historical reruns impossible. No main merge, Cloudflare deployment/resource, billing, state API access or real-data operation is included.

## Local validation and review gate

Both future test sources pass Node syntax checks. Patch applicability was checked with git apply --check against the exact inactive and future-test fixture preimages; no patch was applied to current tests. Sixteen in-memory lifecycle guard probes cover accepted active/cleaned states, v1 presence, missing/extra workflow entries, symlink-like/non-file entries, altered active/template/read-only bytes and failed cleanup. No network token request occurs in these probes.

Independent narrow review found no blocker for this inactive package. The reviewer independently reran 189/189 tests with zero skips, verified the pinned Git objects, reconstructed both two-file patches in memory, checked all four future test sources and exact cleanup restoration, and passed 16 lifecycle probes. Current v1 files remained unchanged and both active workflow paths were absent. Final ordinary CI/readback and fresh history/head checks remain required; separate exact user approval is mandatory before activation.
