# Future bootstrap activation and cleanup test contracts

These are inert review artifacts, not permission to install a workflow, grant `id-token: write`, request a token, or apply either patch. Current tests and `.github/workflows` remain unchanged. The source-pinned template itself remains outside the active workflow directory.

## Fixed candidate

- Repository/PR: `haji84/PERSONAL-AI-HQ`, PR 11.
- Eventual active file: `.github/workflows/hq-oidc-bootstrap-pr11-v1.yml`.
- Reviewed verifier source commit: `8342cbc80f72d2240aaa4bdc6058e78733027f20`.
- Inactive template: `templates/oidc-bootstrap.yml.example`.
- Template and eventual active-file SHA-256: `8d9f705e240e05b7bc13beb4a9a022d0fdd13c33b35d4fbcfa3ac3bd1778b4e4`.
- Unchanged read-only workflow: `.github/workflows/autonomous-manager-plan.yml`, SHA-256 `5dab11b6e988c9d3313c4725588263c6e31ca074c94fe3143fa529d135c7f974`.

The source pin, exact action/runtime/dependency pins, first-run/first-attempt gates, PR/repository/branch guards, minimal job permissions, fixed reserved audience, one-request transport, strict public-only output and cleanup limitations remain as specified in `docs/OIDC_BOOTSTRAP_DESIGN.md`. No verifier implementation or existing read-only workflow changes are proposed here.

## Exact future test transitions

Both patches target only `tests/oidc-bootstrap-proof.test.mjs`. They are stored with `.patch.example` extensions outside the active tests/workflows and must not be applied automatically.

1. **Activation test patch**: `templates/oidc-bootstrap-activation-tests.patch.example`, SHA-256 `98789b987a615ded15f3df0b071632e5917128c0544209a60272716625299910`.
   - Required preimage test SHA-256: `292f9dff25c96f90c55079429ec8a20dc13eaf8c0d8528c34791d9a0146c9355`.
   - Expected resulting test SHA-256: `168e1230aac32c01b7ebf87d075c9da1f6252d00d3334c8f2f07d8284b921532`.
   - Replaces the inactive-path absence assertion with an exact two-entry workflow inventory: the existing read-only workflow and the approved bootstrap path only. Both must be regular, non-symlink files. The bootstrap file must have exactly the reviewed template bytes and fixed hash; the read-only workflow must retain its fixed hash.
   - All original source pin, dependency hash, placeholder rejection, context, permission, output, no-retry and other tests remain. The existing read-only workflow's no-`id-token` assertion also remains.
2. **Cleanup test patch**: `templates/oidc-bootstrap-cleanup-tests.patch.example`, SHA-256 `f7f344bbe227b6be23d6d02c25341161318d8b825780d669431df5ebda7855a3`.
   - Required preimage is the activation-result test hash above.
   - Expected resulting test SHA-256: `69a8c65505d3f1d52ab6de7ffa6be5557419f6ce2308d208e3c1ac25722f9c11`.
   - Restores the bootstrap-path absence assertion and requires an exact one-entry inventory containing only the unchanged read-only workflow. It retains fixed template/read-only hashes and all original source/context/permission/output checks.

The eventual activation commit would copy the exact reviewed template bytes to the approved active path and apply the reviewed activation test patch together, only after explicit user authorization and unused workflow history checks. The eventual cleanup commit would remove that active file and apply the cleanup test patch together. These descriptions do not authorize those operations. Any changed preimage, template, workflow inventory or existing read-only workflow requires renewed review rather than fuzzy patching or bypassing a failing test.

After the one approved run reaches a terminal success, failure or unknown outcome, cleanup must not silently retry or rerun it. Removing the workflow and current permission is not token revocation, does not erase historical executions, and is not a claim that history cannot be rerun. Reserved-audience denial at state authorization remains independent.

## Local artifact verification

Both future test sources pass Node syntax checking. Activation patch applicability was checked with `git apply --check` against the source-pinned stage-B test; cleanup applicability was checked against a standalone future-test fixture. Neither patch was applied to current tests, and no active workflow was created.

Fourteen in-memory probes executed the exact generated lifecycle guard snippets against synthetic filesystem responses: valid active/cleaned states pass; missing/extra workflow entries, changed template/active/read-only bytes, symlink-like entries and active-file presence after cleanup fail. These checks perform no network request and do not execute the bootstrap CLI. They are not evidence of a live GitHub run or token.

Independent review found no blocker for these inert artifacts: the reviewer reconstructed both patches in memory, verified the exact resulting hashes, ran syntax checks and 16 lifecycle probes, and confirmed current tests/template remained unchanged with the active path absent. This is artifact review, not live activation approval or proof. Exact preimages and separate explicit activation/cleanup authorization remain required. Normal read-only CI remains required for any subsequently approved repository changes.
