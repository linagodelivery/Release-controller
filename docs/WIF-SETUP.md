# Google Cloud WIF setup plan (M1.3)

**Status: partially provisioned. The Courier WIF authentication workflow has not yet been dispatched; no authentication result is claimed.**

## Read-only preflight, 2026-11-03

- Project: `deliveryapp-2b7a4`, number `581390628800`; active gcloud account was `naymichahid@gmail.com`.
- GitHub controller: public `linagodelivery/Release-controller`, repository ID `1444309964`, owner ID `266306313`, default branch `main`.
- Initial preflight found no Workload Identity Pool or release service account.
- `iam.googleapis.com`, `iamcredentials.googleapis.com`, `secretmanager.googleapis.com`, and now `sts.googleapis.com` are enabled in `deliveryapp-2b7a4`.
- The pool/provider and five release service accounts listed below have now been created and read back.
- Existing Secret Manager names were inspected as metadata only. No release signing secrets or payloads were read; no secret access is proposed in M1.3.
- Project IAM contains existing application/runtime grants, but no GitHub federated principal. No project role will be granted to the five new release service accounts.
- Organization Policy state is unverified: the API is disabled and was not enabled for this audit.

## Trust design

Create one pool, `github-release-pool`, and one OIDC provider, `github-delivery`, with issuer `https://token.actions.githubusercontent.com`.

The provider must admit only tokens satisfying all of the following:

1. `repository_id == "1444309964"` and `repository_owner_id == "266306313"` (immutable GitHub identities).
2. `repository == "linagodelivery/Release-controller"` (additional diagnostics, not the sole identity check).
3. `ref == "refs/heads/main"` and `event_name == "workflow_dispatch"`.
4. One exact `workflow_ref` and matching `environment` pair from the table below.

Map the relevant claims to WIF attributes. Map `attribute.release_identity` to exactly one enum (`courier-sign`, `shop-sign`, `marketplace-sign`, `courier-play`, or `shop-play`) only when both the corresponding workflow path and environment match; otherwise map it to `unapproved`. The provider condition independently allow-lists the same workflow/environment pairs. Each service account is bound to exactly one `principalSet` for this enum. This makes the per-app distinction enforceable in the service-account IAM policy, rather than relying only on a broad provider condition.

Use the GitHub OIDC `workflow_ref` claim for these ordinary, non-reusable workflow files. It identifies the calling workflow path/ref, e.g. `linagodelivery/Release-controller/.github/workflows/courier-sign.yml@refs/heads/main`. `job_workflow_ref` is for a called reusable workflow and must not be treated as synonymous. The `environment` claim exists for jobs that declare an environment; the approved workflow has that declaration. Do not authorize by the standard `sub` claim alone because its default context changes when an environment is used. Do not hardcode `workflow_sha` into the provider condition: it would stop working after every workflow edit. The resulting residual risk is that a malicious edit to an already-authorized workflow on `main` retains the same `workflow_ref` and can request credentials after the environment gate is approved.

### Workflow identities and account responsibilities

| Identity attribute | Exact workflow | GitHub environment | Service account | Initial Google Cloud application permissions |
|---|---|---|---|---|
| `courier-sign` | `.github/workflows/courier-sign.yml` | `courier-sign` | `gha-courier-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` | None |
| `shop-sign` | `.github/workflows/shop-sign.yml` | `shop-sign` | `gha-shop-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` | None |
| `marketplace-sign` | `.github/workflows/marketplace-sign.yml` | `marketplace-sign` | `gha-marketplace-sign@deliveryapp-2b7a4.iam.gserviceaccount.com` | None |
| `courier-play` | `.github/workflows/courier-play-draft.yml` | `courier-publish` | `gha-courier-play@deliveryapp-2b7a4.iam.gserviceaccount.com` | None |
| `shop-play` | `.github/workflows/shop-play-draft.yml` | `shop-publish` | `gha-shop-play@deliveryapp-2b7a4.iam.gserviceaccount.com` | None |

Only the first workflow is added in this PR, and it is an authentication identity check. Other four workflow files do not yet exist and must not receive `id-token: write` until individually reviewed and their environment rules are read back. The five accounts are separate because signing-secret boundaries must be app-specific and Play permissions later must be app-specific. Marketplace Hosting identity is expressly deferred.

### IAM boundary

Initially, each service account receives only a service-account-scoped `roles/iam.workloadIdentityUser` binding for its own enum attribute. No project-level role, `roles/iam.serviceAccountTokenCreator`, Secret Manager accessor, Play permission, Firebase role, or key is added. WIF User is the permission needed for short-lived service-account impersonation; the service accounts themselves have no resource permissions in M1.3.

The binding member shape is:

```text
principalSet://iam.googleapis.com/projects/581390628800/locations/global/workloadIdentityPools/github-release-pool/attribute.release_identity/IDENTITY
```

`IDENTITY` is one exact enum from the table. Do not put several `principalSet` members in one binding expecting them to be ANDed: IAM members are alternatives. Keep each service account's one member distinct.

## Provisioning record

The operator authorized M1.3-B provisioning. Current read-back:

- Pool `github-release-pool`: present, global.
- Provider `github-delivery`: `ACTIVE`, issuer `https://token.actions.githubusercontent.com`; mappings and condition read back exactly as specified above.
- All five service accounts exist: `gha-courier-sign`, `gha-shop-sign`, `gha-marketplace-sign`, `gha-courier-play`, and `gha-shop-play`.
- Only Courier currently has an impersonation binding, because `.github/workflows/courier-sign.yml` is the only implemented/reviewed identity workflow:

  ```text
  serviceAccount: gha-courier-sign@deliveryapp-2b7a4.iam.gserviceaccount.com
  role: roles/iam.workloadIdentityUser
  member: principalSet://iam.googleapis.com/projects/581390628800/locations/global/workloadIdentityPools/github-release-pool/attribute.release_identity/courier-sign
  ```

- The four future accounts have no WIF binding until their corresponding workflow files exist and are reviewed. The provider allowlist reserves their documented exact workflow/environment pairs, but no other workflow can map to those release-identity values.
- No release account has a project-level role. No user-managed service-account keys were found. No existing Secret Manager policy references any of the five account emails. No secret access, Play, Firebase, Storage, or Hosting permissions were granted.
- The Courier workflow has **not** completed a WIF run yet. The GitHub environment API and Actions permission settings are unavailable through the current connector; the prior environment smoke run demonstrated that `courier-sign` waited for manual approval.

The initial reviewed setup commands follow. Do not rerun resource-creation commands against the existing resources. The actual effective configuration is the read-back above, not merely the command text.

PowerShell commands below create only the approved pool, provider, five service accounts, and five service-account-level WIF User bindings. First re-run the read-only checks and stop if any named resource now exists; do not overwrite it.

```powershell
$ProjectId = 'deliveryapp-2b7a4'
$ProjectNumber = '581390628800'
$Pool = 'github-release-pool'
$Provider = 'github-delivery'

# STS was enabled for this project as part of the approved setup.
gcloud services enable sts.googleapis.com --project=$ProjectId

gcloud iam workload-identity-pools create $Pool `
  --project=$ProjectId --location=global `
  --display-name='GitHub Release Controller' `
  --description='Keyless identities for explicitly allow-listed Linago release workflows'

$Mapping = 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment,attribute.release_identity=assertion.workflow_ref == "linagodelivery/Release-controller/.github/workflows/courier-sign.yml@refs/heads/main" && assertion.environment == "courier-sign" ? "courier-sign" : assertion.workflow_ref == "linagodelivery/Release-controller/.github/workflows/shop-sign.yml@refs/heads/main" && assertion.environment == "shop-sign" ? "shop-sign" : assertion.workflow_ref == "linagodelivery/Release-controller/.github/workflows/marketplace-sign.yml@refs/heads/main" && assertion.environment == "marketplace-sign" ? "marketplace-sign" : assertion.workflow_ref == "linagodelivery/Release-controller/.github/workflows/courier-play-draft.yml@refs/heads/main" && assertion.environment == "courier-publish" ? "courier-play" : assertion.workflow_ref == "linagodelivery/Release-controller/.github/workflows/shop-play-draft.yml@refs/heads/main" && assertion.environment == "shop-publish" ? "shop-play" : "unapproved"'

$Condition = 'attribute.repository_id == "1444309964" && attribute.repository_owner_id == "266306313" && attribute.repository == "linagodelivery/Release-controller" && attribute.ref == "refs/heads/main" && attribute.event_name == "workflow_dispatch" && ((attribute.workflow_ref == "linagodelivery/Release-controller/.github/workflows/courier-sign.yml@refs/heads/main" && attribute.environment == "courier-sign") || (attribute.workflow_ref == "linagodelivery/Release-controller/.github/workflows/shop-sign.yml@refs/heads/main" && attribute.environment == "shop-sign") || (attribute.workflow_ref == "linagodelivery/Release-controller/.github/workflows/marketplace-sign.yml@refs/heads/main" && attribute.environment == "marketplace-sign") || (attribute.workflow_ref == "linagodelivery/Release-controller/.github/workflows/courier-play-draft.yml@refs/heads/main" && attribute.environment == "courier-publish") || (attribute.workflow_ref == "linagodelivery/Release-controller/.github/workflows/shop-play-draft.yml@refs/heads/main" && attribute.environment == "shop-publish"))'

gcloud iam workload-identity-pools providers create-oidc $Provider `
  --project=$ProjectId --location=global --workload-identity-pool=$Pool `
  --display-name='GitHub Release Controller' `
  --issuer-uri='https://token.actions.githubusercontent.com' `
  --attribute-mapping=$Mapping --attribute-condition=$Condition

$Identities = @(
  @{Id='courier-sign'; Sa='gha-courier-sign'; Attribute='courier-sign'},
  @{Id='shop-sign'; Sa='gha-shop-sign'; Attribute='shop-sign'},
  @{Id='marketplace-sign'; Sa='gha-marketplace-sign'; Attribute='marketplace-sign'},
  @{Id='courier-play'; Sa='gha-courier-play'; Attribute='courier-play'},
  @{Id='shop-play'; Sa='gha-shop-play'; Attribute='shop-play'}
)
foreach ($Identity in $Identities) {
  gcloud iam service-accounts create $Identity.Sa --project=$ProjectId `
    --display-name="GitHub $($Identity.Id) release identity"
  $Member = "principalSet://iam.googleapis.com/projects/$ProjectNumber/locations/global/workloadIdentityPools/$Pool/attribute.release_identity/$($Identity.Attribute)"
  $Email = "$($Identity.Sa)@$ProjectId.iam.gserviceaccount.com"
  gcloud iam service-accounts add-iam-policy-binding $Email --project=$ProjectId `
    --role=roles/iam.workloadIdentityUser --member=$Member
}
```

### Verification and remaining auth gate

The pool/provider, mappings/condition, five account policies, keys, project IAM, and Secret Manager IAM were read back. Before another identity workflow is enabled, manually verify its environment reviewer and branch restrictions in GitHub Settings. For the existing Courier workflow, trigger it from `main`; approve its `courier-sign` deployment yourself, then verify the authenticated account name. Never display access tokens or credential-file contents. Do not retrieve secrets or call Play/Firebase APIs. Negative tests still required: another repository, non-main branch, pull request, unauthorized workflow/environment, and cross-account impersonation. The GitHub connector cannot dispatch workflows or read the environment/Actions settings APIs; the browser control host is unavailable in this session.

## Approval and residual security limits

The smoke run proves that `courier-sign` waited at an environment gate. It does not prove independent approval: the solo operator can change `main` and approve the environment. The main ruleset currently requires a PR but has zero required approvals and CODEOWNERS review is disabled. WIF limits which workflow paths can request which service-account identity; it cannot establish that the workflow contents are benign. GitHub dependency/action compromise and a compromised operator account remain in scope.

The sole operator can change `main` and approve environment jobs. This is not independent dual control. The main ruleset still has zero required PR approvals and CODEOWNERS enforcement is off. Keep the four future identities unbound until their workflows and environment settings are verified. The Courier auth workflow remains limited to read-only credential exchange and prints only the service account identity.

## Rollback (only after an approved setup)

Remove each exact service-account-level binding first; then delete the service accounts, provider, and pool. Do not delete Secret Manager resources or other production resources. Do not disable STS automatically because another workload might begin using it.

```powershell
$ProjectId = 'deliveryapp-2b7a4'
$ProjectNumber = '581390628800'
$Pool = 'github-release-pool'
$Provider = 'github-delivery'
# For each table entry, substitute its exact email and attribute value:
$Email = 'gha-courier-sign@deliveryapp-2b7a4.iam.gserviceaccount.com'
$Member = 'principalSet://iam.googleapis.com/projects/581390628800/locations/global/workloadIdentityPools/github-release-pool/attribute.release_identity/courier-sign'
gcloud iam service-accounts remove-iam-policy-binding $Email --project=$ProjectId `
  --role=roles/iam.workloadIdentityUser --member=$Member
# Repeat the removal above for all five accounts, then:
gcloud iam service-accounts delete $Email --project=$ProjectId
# Repeat account deletion for the other four accounts.
gcloud iam workload-identity-pools providers delete $Provider --project=$ProjectId `
  --location=global --workload-identity-pool=$Pool
gcloud iam workload-identity-pools delete $Pool --project=$ProjectId --location=global
```

The current project owner account can perform these commands. Do not download service-account JSON keys. Estimated recurring cost for the pool/provider and idle service-account identities is none; enabling the API and issuing short-lived tokens has no provisioned compute/storage footprint. Cloud audit events are limited to WIF exchanges and IAM administration.
