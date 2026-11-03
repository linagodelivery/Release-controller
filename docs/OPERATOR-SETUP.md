# Operator setup checklist

These are required settings, not settings already verified or applied.

## 1. Protect `main`

In repository settings, create a ruleset targeting the default branch `main`:

- Require pull requests before merging.
- Require at least one approval and required CODEOWNERS review.
- Dismiss stale approvals after new commits.
- Block force-push and branch deletion.
- Do not grant bypass to administrators or other actors.
- Ensure only trusted maintainers can edit repository rules and Actions policy.

Read back the ruleset and confirm its target, rules, bypass list, and enforcement state.

## 2. Restrict Actions

Set repository Actions default `GITHUB_TOKEN` permissions to read-only contents. Do not enable workflows that retrieve signing or publishing credentials yet. Review allowed Actions and require full-SHA pinning in workflow review/policy.

## 3. Protect release environments

Create separate environments for each app and purpose, for example:

- `courier-sign`, `shop-sign`, `marketplace-sign`
- `courier-play-draft`, `shop-play-draft`

Configure required reviewers for each. Where a second reviewer is available, prevent self-review. Verify the environment rules are active on this public repository; the same settings are unavailable for private repositories on GitHub Free.

Do not add signing secrets to GitHub environments. Future signing credentials should be in Secret Manager and available only to app-specific signing identities through WIF after M1.3 approval.

## 4. Private Delivery read access (future, not configured)

Prefer a GitHub App installed only on `linagodelivery/Delivery`, with read-only Contents permission. Issue a short-lived installation token in the unprivileged build job and use it only to fetch the operator-selected immutable commit. Do not expose that token to build scripts, logs, artifacts, signing, or publishing jobs. Revoke/uninstall the app if the release controller is retired.

Do not use a broad PAT. No GitHub App, private-source access, WIF, service account, Play permission, or cloud secret has been configured by M1.2.

## 5. Before enabling any workflow

Read back and record:
- controller repository ID `1444309964`, organization ID `266306313`, public visibility, and default branch `main`;
- active main ruleset, review requirement, CODEOWNERS enforcement, and bypass list;
- each environment's required reviewers and self-review setting;
- Actions default permissions and allowed-action policy;
- exact workflow paths and reviewed commit SHAs.

If a required protection is inactive or cannot be enforced, stop before adding credentials or enabling credentialed workflows.
