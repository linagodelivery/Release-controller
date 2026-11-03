# Release architecture

## Trust boundaries

The source of truth remains the private `linagodelivery/Delivery` repository. This public repository holds only release control and verification code.

1. **Source selection:** select an immutable Delivery commit. A future GitHub App should have read-only Contents access to Delivery only. Do not use a broad, long-lived PAT.
2. **Build:** build that exact commit in an unprivileged job. It receives no signing or publishing credentials. Never publish a private source archive, source tree, or private build logs as public artifacts.
3. **Artifact verification:** verify provenance, immutable source SHA, package/application ID, version, expected signer identity, and artifact digest. A sidecar checksum alone does not prove provenance.
4. **Signing approval:** require human approval through a protected environment. The isolated signing job consumes the reviewed artifact and fixed, pinned signing tooling only. It must not execute Gradle, repository scripts, or artifact-provided programs. Signing credentials are app-specific.
5. **Publication approval:** use a separate protected environment. The publishing identity cannot access signing secrets. Courier and Shop create non-live testing drafts only; an operator reviews and publishes the draft in Play Console.
6. **Marketplace:** sign a verified APK. Hosting publication remains deferred and must use a separate promotion step and identity. Do not grant Firebase Hosting Admin to build or signing identities.

## GitHub Free controls

This public controller is intended to use GitHub Free protections: require pull requests and CODEOWNERS review for `main`, block force-push/deletion, and apply required reviewers to signing and publishing environments. Read the settings back after configuration. `workflow_dispatch`, a branch name, and an environment name alone do not constitute human approval.

Do not add credentialed workflows until protections are verified. A compromised release-controller workflow remains high impact; limit who can change repository rules and review every workflow change.

## WIF identity

Future WIF should trust controller repository ID `1444309964`, with organization ID `266306313` as supplementary context—not the private Delivery repository ID. Restrict the provider to exact `main` workflow identities and approved event/environment claims; bind each service account only to its intended release identity. The environment claim identifies a job; the enforced environment reviewer rule supplies the approval gate.

## Artifact handling

Bind each artifact to its source commit and workflow run. Verify the same artifact digest at signing and publishing. Keep artifact access private and retention short. Never publish private source archives or private build logs.
