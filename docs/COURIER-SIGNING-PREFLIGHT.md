# Courier signing boundary preflight

This workflow is a dry-run security boundary check. It does not sign an AAB,
read Secret Manager, publish to Play, or change Firebase resources.

## Pipeline split

1. `Delivery/.github/workflows/courier-unsigned-release-candidate.yml` runs only
   by manual dispatch from `main`. The operator supplies a full Delivery commit
   SHA. The job confirms that commit is an ancestor of protected `main`, runs
   the focused Courier tests, compiles the R8 release variant, and creates an
   unsigned AAB. It has `contents: read` only, no `id-token: write`, and no
   signing credentials. Its artifact remains in the private Delivery
   repository for one day.
2. `.github/workflows/courier-sign.yml` retains the exact path and
   `courier-sign` environment already admitted by WIF. The environment approval
   gates the job. The controller requires the selected source SHA to equal the
   successful build run's GitHub API `head_sha`, verifies the selected attempt,
   and approves only the exact SHA-256 of the build workflow file stored in
   `scripts/courier-build-workflow-policy.json`. Updating that workflow requires
   an explicit controller policy change through a PR. The workflow verifies
   the artifact API record, downloads that exact artifact ID from the run, and
   checks its API digest, AAB integrity, unsigned state,
   structure, package ID and version before requesting WIF credentials.
3. The final step confirms the expected Courier service-account identity. It
   does not read Secret Manager or sign the bundle. The service account
   currently has no resource permissions beyond the service-account-scoped WIF
   binding.

The public controller never uploads or republishes the private AAB. GitHub
artifact access follows repository read access, so private source artifacts
must remain in the private Delivery repository. The short-lived GitHub App
installation token is restricted to Delivery and is used only for read-only
Actions and Contents API access.

## Required configuration before a run

The private Delivery repository needs Actions secrets:

- `COURIER_GOOGLE_SERVICES_JSON`: the restricted Courier Firebase client
  configuration for project `deliveryapp-2b7a4`.
- `COURIER_MAPS_API_KEY`: a Maps key restricted to the Courier application and
  required APIs.

These are application build configuration, not signing keys. They are
materialized only for the build and removed in an `always()` cleanup step. The
selected application source executes during Gradle; consequently these
application-bound client values are visible to that source. Do not put any
signing credential in the build repository or build workflow.

The `courier-sign` GitHub environment needs two secrets for a GitHub App
installation restricted to the private Delivery repository:

- `DELIVERY_ARTIFACT_READER_APP_ID`
- `DELIVERY_ARTIFACT_READER_PRIVATE_KEY`

The App needs only Actions: read and Contents: read. It has no write access,
Google Cloud access, Secret Manager access, or Play permissions. Do not use a
personal access token. These App secrets are not the Android signing key or
passwords.

The Google Cloud WIF provider already admits the exact controller workflow
path `.github/workflows/courier-sign.yml`, `workflow_dispatch`, `main`, and the
`courier-sign` environment. Do not change the provider or IAM bindings for this
preflight. The workflow authenticates only after candidate validation.

## Bundle validation and signing format

The candidate is a Google Play AAB, not an APK. The verifier pins Bundletool
1.18.3 by SHA-256 and validates the actual bundle manifest. Google documents
JAR signing (`jarsigner`) for AABs; `apksigner` is for APKs and cannot sign an
AAB. A later signing milestone must run only the platform JDK's `jarsigner`
after all private artifact checks, then independently inspect the final
certificate fingerprint. It must not invoke Gradle or app repository code.

## Limits

- The approved workflow-file digest is computed from the workflow file fetched
  through GitHub's Contents API at the run's `head_sha`. GitHub's workflow-run
  API does not expose a separate cryptographic “executed workflow blob digest”.
  For this manual dispatch from `main`, the run path, workflow ID/path, run
  head commit, and independently fetched file digest are jointly checked. This
  is a fail-closed verification based on available GitHub metadata, not a signed
  attestation of the runner's internal workflow loader.
- The artifact API exposes the artifact ID/digest and run/repository/head-SHA
  association, but not a `run_attempt` field. The controller checks the
  requested attempt through both run and attempt API responses, requires one
  unique matching artifact, downloads that immutable artifact ID, and checks
  the build-generated manifest's attempt against the selected attempt. The
  manifest is not treated as independent
  provenance; conflicting or ambiguous artifacts are rejected. The pinned
  download action errors on its artifact digest mismatch check, and the
  controller separately verifies the AAB SHA-256.
- The selected source must equal the run head SHA, as well as remain an
  ancestor of Delivery `main`. This prevents selecting an obsolete historical
  source while binding the output to the immutable commit used by the manual
  run.
- The controller parses exactly one `applicationId`, `versionCode`, and
  `versionName` declaration from the selected Gradle source, then compares
  those values against the actual AAB manifest parsed by pinned Bundletool.
  Build-generated manifest fields are not authoritative.
- The source code itself is selected from protected `main` and executes
  unprivileged during build. A malicious but merged source commit could still
  produce malicious app behavior. Environment approval is an operator gate,
  not independent review.
- Delivery does not currently have Gradle dependency locking or verification
  metadata. The source commit and tool versions are recorded, but full
  dependency reproducibility remains open.
- This dry run does not prove Play upload-certificate parity or production
  signing. The locally verified Courier key still needs authoritative Play
  Console confirmation before secret provisioning.

## Operator procedure

1. Dispatch the private Delivery candidate workflow from `main` with the exact
   current `main` SHA. Wait for all focused tests and the unsigned R8 AAB build
   to succeed; record the run ID and successful attempt from GitHub.
2. Dispatch the controller's Courier signing-boundary preflight from `main`
   with that source SHA, build run ID, and run attempt.
3. Review the source/run identity in the run and approve `courier-sign` in
   GitHub. The workflow will validate the private AAB and perform WIF identity
   verification only. No signature is produced.
4. Stop if the package, version, SHA, workflow path, run, or identity check
   differs from expectation.

## Next milestone

Before a real signing test, separately authorize and complete the GitHub App
read-only setup, restricted build-configuration secrets, Play upload
certificate verification, Secret Manager secret creation, and secret-level
IAM access. Then add a reviewed signing step that runs `jarsigner` only after
all source and artifact checks, with cleanup on every exit path. Do not add
Play publishing permissions to this workflow.
