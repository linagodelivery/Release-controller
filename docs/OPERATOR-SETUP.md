# Operator setup checklist

These are required settings, not settings already verified or applied.

## 1. Verified GitHub state and remaining checks

The public repository is `linagodelivery/Release-controller`, ID `1444309964`, owner ID `266306313`, default branch `main`. Its active ruleset targets `refs/heads/main`, requires PRs, blocks force-push/non-fast-forward and deletion, and has no bypass actors. Required PR approvals are currently `0`; CODEOWNERS enforcement is off. This supports a solo operator but provides no independent review. The Actions permission endpoint and environment list could not be read through the available connector. The courier-sign environment gate did wait for operator approval in run [41698194418](https://github.com/linagodelivery/Release-controller/actions/runs/41698194418); verify the other four environments in GitHub Settings before using them.

Keep Actions workflow permissions at the minimum. Each credentialed job must set its own permissions explicitly; the Courier WIF smoke job requests only `contents: read` and `id-token: write`. Continue to pin every Action to a reviewed full commit SHA.

## 2. WIF proposal (not yet applied)

Project: `deliveryapp-2b7a4` / `581390628800`.

- Pool: `github-release-pool`.
- Provider: `github-delivery`, issuer `https://token.actions.githubusercontent.com`.
- Exact provider admission: repository ID `1444309964`, owner ID `266306313`, repository name `linagodelivery/Release-controller`, `refs/heads/main`, `workflow_dispatch`, and the workflow/environment pairs in `RELEASE-ARCHITECTURE.md`.
- Map an enum attribute `release_identity`; it must yield `courier-sign`, `shop-sign`, `marketplace-sign`, `courier-play`, or `shop-play` only for its exact workflow/environment pair and `unapproved` otherwise.
- Each app/operation service account receives only a service-account-level `roles/iam.workloadIdentityUser` binding for its own `principalSet` enum value. Do not grant project roles, self Token Creator, Secret Manager access, Play permissions, Firebase permissions, or create keys in this milestone.
- Required service accounts: `gha-courier-sign`, `gha-shop-sign`, `gha-marketplace-sign`, `gha-courier-play`, `gha-shop-play`.

The exact CEL and IAM commands prepared for an approved change are in `WIF-SETUP.md`. They are examples for review and must not be run until the operator approves the complete mutation plan. The STS API is currently disabled and enabling it is part of that approval. Organization Policy metadata is unverified because the API is disabled and was not enabled for this audit.

## 3. Protect release environments

Expected environments:

- Signing: `courier-sign`, `shop-sign`, `marketplace-sign`.
- Play draft preparation: `courier-publish`, `shop-publish`.

No JKS, password, Play credential, service-account key, or other secret belongs in GitHub. Future signing credentials should be in Secret Manager and accessible only to app-specific signing identities after a separate approval. Publishing identities receive Play permissions later and never receive signing-secret access.

## 4. Private Delivery read access (future, not configured)

Prefer a GitHub App installed only on `linagodelivery/Delivery`, with read-only Contents permission. Issue a short-lived installation token in the unprivileged build job and use it only to fetch the operator-selected immutable commit. Do not expose that token to build scripts, logs, artifacts, signing, or publishing jobs. Revoke/uninstall the app if the release controller is retired.

Do not use a broad PAT. No GitHub App or private-source access has been configured. M1.3 WIF resources and service accounts are still pending explicit operator approval. No Play permission, signing secret, or cloud secret access is included.

## 5. Before enabling any workflow

Read back and record:
- controller repository ID `1444309964`, organization ID `266306313`, public visibility, and default branch `main`;
- active main ruleset, review requirement, CODEOWNERS enforcement, and bypass list;
- each environment's required reviewers and self-review setting;
- Actions default permissions and allowed-action policy;
- exact workflow paths and reviewed commit SHAs.

If an environment's reviewer/branch restrictions or repository Actions policy cannot be verified, stop before granting that workflow impersonation. Because the sole operator can edit `main` and approve environment jobs, this design is not independent dual control; protect the GitHub account with MFA and limit write access.
