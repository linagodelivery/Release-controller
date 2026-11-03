# Security policy

This public repository controls future release automation. Treat workflow and release-verification changes as security-sensitive.

## Reporting

Do not open a public issue containing credentials, private source, customer data, or exploit details. Report suspected vulnerabilities privately to Linago organization/repository administrators through an established private channel.

## Repository boundaries

- Keep application source copied from `linagodelivery/Delivery` out of this repository.
- Never commit JKS/PKCS12 files, passwords, service-account JSON keys, access tokens, or production configuration secrets.
- Do not add credentialed workflows until main-branch and environment protections have been read back and verified.
- Keep CODEOWNERS for `.github/**` and release scripts. As of the M1.3 preflight, the active `main` ruleset requires PRs but has zero required approvals and does **not** enforce CODEOWNERS review; the file alone is not a review gate. Re-read the ruleset before adding any credentials.
- Pin third-party Actions to reviewed full commit SHAs.
- Use least-privilege, short-lived WIF credentials; do not create service-account keys.
- Separate build, signing, and publishing jobs and identities.
- Build jobs receive no signing or publishing credentials. Signing jobs must not run Gradle or private-repository scripts. Publishing jobs cannot read signing secrets.
- Public logs and artifacts must not disclose private source contents or secrets.
