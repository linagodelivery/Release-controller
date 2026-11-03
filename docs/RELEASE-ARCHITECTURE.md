# Release architecture

## Trust boundaries

The source of truth remains the private `linagodelivery/Delivery` repository. This public repository holds only release control and verification code.

1. **Source selection:** select an immutable Delivery commit. A future GitHub App should have read-only Contents access to Delivery only. Do not use a broad, long-lived PAT.
2. **Build:** build that exact commit in an unprivileged job. It receives no signing or publishing credentials. Never publish a private source archive, source tree, or private build logs as public artifacts.
3. **Artifact verification:** verify provenance, immutable source SHA, package/application ID, version, expected signer identity, and artifact digest. A sidecar checksum alone does not prove provenance.
4. **Signing approval:** require human approval through a protected environment. The isolated signing job consumes the reviewed artifact and fixed, pinned signing tooling only. It must not execute Gradle, repository scripts, or artifact-provided programs. Signing credentials are app-specific.
5. **Publication approval:** use a separate protected environment. The publishing identity cannot access signing secrets. Courier and Shop create non-live testing drafts only; an operator reviews and publishes the draft in Play Console.
6. **Marketplace:** sign a verified APK. Hosting publication remains deferred and must use a separate promotion step and identity. Do not grant Firebase Hosting Admin to build or signing identities.

Courier's current implementation proposal is documented in
[`COURIER-SIGNING-PREFLIGHT.md`](COURIER-SIGNING-PREFLIGHT.md). The build runs
inside the private Delivery repository and keeps its short-lived unsigned AAB
there; the public controller downloads it only inside the protected
`courier-sign` job. The present controller workflow is a no-signing dry run:
it validates source/run/artifact identity, then verifies WIF. It does not read
Secret Manager or sign an artifact.

## GitHub Free controls (read back 2026-11-03)

The public `linagodelivery/Release-controller` repository (ID `1444309964`, organization ID `266306313`) has an active ruleset targeting `refs/heads/main`. It requires pull requests, blocks deletion and non-fast-forward updates, and has no bypass actors. The current ruleset has **zero required PR approvals** and does not enforce CODEOWNERS review. This matches the single-operator decision; it is not independent review. Repository Actions default permissions and the full configuration of four environments were not readable through the available GitHub API connection and remain unverified.

The `courier-sign` environment approval gate was exercised by run [41698194418](https://github.com/linagodelivery/Release-controller/actions/runs/41698194418): the job waited from 18:54:14Z until 18:57:21Z, and the operator reports approving it. The job then completed successfully. This verifies a manual environment gate for that environment, not two-person control. The other environments still need a read-back before their identities are used.

An environment reviewer can gate a job, but the same operator can change workflow source and approve its run. A compromised GitHub account, merged malicious workflow change, dependency compromise in a privileged job, or service-account permission error can defeat the intended boundary. Keep credentials unavailable until the exact workflow is reviewed; do not treat the GitHub Free configuration as protection from a compromised controller maintainer.

## WIF identity

Use the Google Cloud project `deliveryapp-2b7a4` (number `581390628800`), pool `github-release-pool`, provider `github-delivery`, and issuer `https://token.actions.githubusercontent.com`. Trust only the public controller repository ID `1444309964` and organization ID `266306313`; never use the private Delivery repository ID as the trusted issuer boundary.

Map `google.subject=assertion.sub`, immutable repository and owner IDs, and one synthetic `attribute.release_identity`. The synthetic attribute must return an allow-listed value only for an exact pair of `assertion.workflow_ref` and `assertion.environment`; otherwise it returns `unapproved`. The provider condition separately checks the immutable repository and owner IDs, repository name, `refs/heads/main`, `workflow_dispatch`, and the exact workflow/environment allow-list. Each service account's `roles/iam.workloadIdentityUser` binding then names only its single synthetic release identity. This avoids treating multiple independent `principalSet` members as an AND constraint: members in one IAM binding would be alternatives, not a conjunction.

Use the caller workflow's `workflow_ref` for the dedicated, non-reusable workflow files listed in the WIF plan. `job_workflow_ref` identifies a called reusable workflow and is absent for ordinary jobs; do not substitute it for `workflow_ref`. The `environment` claim is present only for jobs that declare an environment. `workflow_sha` identifies the workflow file's source commit but is deliberately not pinned in the provider because a fixed SHA would stop authentication after any reviewed workflow edit. This means a malicious change to an authorized workflow on `main` remains a residual risk.

The initial approved workflow identity mapping is:

| Release identity | Exact workflow path | Required environment | Service account |
|---|---|---|---|
| `courier-sign` | `.github/workflows/courier-sign.yml` | `courier-sign` | `gha-courier-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` |
| `shop-sign` | `.github/workflows/shop-sign.yml` | `shop-sign` | `gha-shop-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` |
| `marketplace-sign` | `.github/workflows/marketplace-sign.yml` | `marketplace-sign` | `gha-marketplace-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` |
| `courier-play` | `.github/workflows/courier-play-draft.yml` | `courier-publish` | `gha-courier-play@deliveryapp-2b7a4.iam.gserviceaccount.com` |
| `shop-play` | `.github/workflows/shop-play-draft.yml` | `shop-publish` | `gha-shop-play@deliveryapp-2b7a4.iam.gserviceaccount.com` |

These names are exact trust identifiers, not proof that the corresponding workflows already exist or have been reviewed. The PR for M1.3 adds only the Courier auth smoke workflow. Other workflows must not receive `id-token: write` until their files exist and are reviewed. No service-account key, project-level application role, secret access, Play access, Firebase access, or Hosting access is part of the initial WIF setup.

## Artifact handling

Bind each artifact to its source commit and workflow run. Verify the same artifact digest at signing and publishing. Keep artifact access private and retention short. Never publish private source archives or private build logs.
