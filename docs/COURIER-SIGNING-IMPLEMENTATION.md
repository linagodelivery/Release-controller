# Courier AAB signing (M1.5-C2)

The manual `courier-sign` workflow accepts only the inputs used by the existing provenance verifier: a Delivery source SHA, build run ID, and run attempt. The protected environment gates the job before its first step. The controller then verifies the successful private Delivery run, approved build-workflow digest, run attempt, artifact ID and digest, and unsigned Courier package/version before Google authentication. It also requires the selected source SHA to still equal the live Delivery `main` head; if `main` advances between the build and signing preflight, rebuild instead of signing the older candidate.

After the existing `gha-courier-sign` WIF authentication, the job checks the active principal and reads only Secret Manager version `1` of `courier-signing-keystore`, `courier-signing-store-password`, and `courier-signing-key-password`. Payloads are written directly to owner-only files beneath the hosted runner's temporary directory. Neither Gradle nor Delivery application scripts run in the credentialed stage.

The trusted Node signing helper uses the exact Temurin JDK `21.0.13.0.2+1` `jarsigner` with `-storepass:file` and `-keypass:file`; secret values never appear in arguments. It signs to a separate temporary AAB, verifies the JAR signature, extracts the signer certificate through `keytool -printcert -rfc`, compares SHA-256 to the pinned Courier upload certificate, and validates AAB structure/package/version with the pre-pinned Bundletool. The helper rechecks the candidate digest and verified run metadata before signing. Temporary keystore, password files, candidate, bundletool, and signed AAB are removed by an `always()` cleanup step. Hosted-runner disk erasure is not guaranteed.

The verified signed AAB is streamed directly to the private `linago-courier-releases` bucket through the Cloud Storage JSON upload API. The request sets `ifGenerationMatch=0`, includes an `X-Goog-Hash` MD5 for server-side transfer integrity, and uses a source/run/attempt/version-specific object name. The response must identify the bucket, exact object, generation, size, and MD5. The workflow logs only the object identifier, generation, size, and SHA-256. The service account has bucket-scoped `roles/storage.objectCreator`, so it cannot read, overwrite, or delete objects. There is no public GitHub artifact, signed URL, Play upload, or Firebase operation.

## Failure handling

- Any provenance, digest, identity, version, password, alias, certificate, signature, or Bundletool failure stops the job. The original candidate is not replaced; a partial local output is removed.
- Secret access is pinned to version `1`; access errors stop without falling back to another version or key. The `always()` cleanup removes any files already retrieved.
- A Storage HTTP 412 means the immutable destination already exists. The workflow does not overwrite it. Do not rerun against that object path. If an upload response is lost after the server accepted the object, use an authorized operator metadata read to determine its generation and digest before deciding the next action; the signing identity itself cannot perform that read.
- Other upload failures stop the job; no alternate bucket or public destination is used. If the result is uncertain, inspect bucket metadata before retrying.
- A hosted runner is ephemeral, but secure physical erasure of runner storage is not claimed.

## Trust limits

The verified artifact ID/digest binds the downloaded file to the selected successful Delivery workflow run, and the controller accepts only the approved build workflow digest and current `main` source SHA. This does not prove that application source merged into Delivery `main` is benign: a malicious committed Gradle/app change can produce a malicious AAB that still passes package/version checks. A compromised GitHub account, runner, pinned action/tool, or authorized controller workflow can also misuse the signing identity. The solo operator can modify controller `main` and approve the environment; this is a manual gate, not independent two-person approval. Keep the controller and dependencies reviewed, and inspect the signed artifact before any separate publishing milestone.

## First authorized signing run

After this change is reviewed and merged, verify the three version-1 secret metadata states, the `courier-sign` environment approval, WIF provider and service-account policy, and the private bucket configuration. Start the Delivery unsigned build for an approved current `main` SHA. Then manually dispatch this controller workflow with that exact SHA, successful Delivery run ID, and run attempt. Approve `courier-sign` in GitHub. Confirm the provenance checks, upload-certificate fingerprint, package/version, object generation and signed SHA-256. Do not upload to Google Play as part of this signing test.

The workflow intentionally does not provide an automatic fallback. Failed signing credentials require an operator-managed secret repair and a new reviewed run; no secret payload should be printed for diagnosis.
