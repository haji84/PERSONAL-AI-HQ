# Public repository security policy

## Never commit
API tokens, cookies, SSH keys, OAuth refresh tokens, real names/addresses/contact information, private repository source, customer data, medical/financial records, device identifiers, private prompts or raw logs.

## Required safeguards
- .gitignore for .env*, credentials, local databases, private data, logs, and generated artifacts.
- Secret scanning before commits and in CI; block merges on findings. A scanner does not guarantee detection.
- Synthetic fixtures only; review diffs before publication.
- Separate private runtime and encrypted private storage; key material must not be stored alongside ciphertext.
- Redact structured logs and model inputs; minimize personal context before sending to third-party AI.
- Token rotation and incident-response procedure for accidental disclosure; removing a commit alone is insufficient.
- Branch protections, independent review, least privilege, explicit approval and fail-closed behavior.

## Public limitations
Public repository history and CI artifacts may be accessible to others. Do not use public Issues, PR comments, Actions logs, or screenshots for sensitive information. GitHub Actions secrets protect values only if workflows and logs are designed safely.
