import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBundle } from './verify-courier-unsigned-candidate.mjs';

const EXPECTED_PACKAGE = 'com.linago.courier';
const EXPECTED_KEY_ALIAS = 'linago-courier-upload';
const COURIER_UPLOAD_CERTIFICATE_SHA256 = 'E20D66F273699CEF3DD4C21AD51F60AEFD4E93F2142133659EF54C946D15C6BE';

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function normalizedFingerprint(value) {
  return value.replaceAll(':', '').replaceAll(' ', '').toUpperCase();
}

function runTrustedTool(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`${basename(command)} failed; signing stopped without exposing tool output.`);
  }
}

async function requirePrivateRegularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`${label} must be a non-empty regular file.`);
  }
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are broader than owner-only.`);
  }
}

export async function signAndVerifyCourierBundle({
  artifactDir,
  verificationPath,
  outputPath,
  keystorePath,
  storePasswordPath,
  keyPasswordPath,
  bundletoolJar,
  sourceSha,
  buildRunId,
  buildRunAttempt,
  expectedVersionCode,
  expectedVersionName,
  expectedCertificateSha256 = COURIER_UPLOAD_CERTIFICATE_SHA256,
  keyAlias = EXPECTED_KEY_ALIAS,
  inspect = inspectBundle,
  runTool = runTrustedTool,
}) {
  assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
  assert.match(String(buildRunId ?? ''), /^\d{1,20}$/);
  assert.match(String(buildRunAttempt ?? ''), /^[1-9]\d{0,5}$/);
  assert.match(String(expectedVersionCode ?? ''), /^[1-9]\d{0,8}$/);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(expectedVersionName ?? '')) throw new Error('Expected Courier version name is invalid.');
  if (!/^(?:[0-9A-F]{2}:?){32}$/i.test(expectedCertificateSha256 ?? '')) throw new Error('Expected Courier certificate fingerprint is invalid.');

  const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
  const candidateRoot = resolve(artifactDir);
  const inputPath = resolve(candidateRoot, verification.aab ?? '');
  if (dirname(inputPath) !== candidateRoot || !inputPath.endsWith('.aab') || basename(inputPath) !== verification.aab) {
    throw new Error('Verified candidate references an invalid AAB path.');
  }
  if (verification.sourceSha !== sourceSha || String(verification.buildRunId) !== String(buildRunId) ||
      String(verification.buildRunAttempt) !== String(buildRunAttempt) || verification.packageName !== EXPECTED_PACKAGE ||
      Number(verification.versionCode) !== Number(expectedVersionCode) || verification.versionName !== expectedVersionName ||
      !/^[0-9a-f]{64}$/.test(verification.sha256 ?? '')) {
    throw new Error('Candidate verification metadata differs from the approved run.');
  }

  const candidateEntries = await readdir(candidateRoot);
  if (candidateEntries.length !== 3 || !candidateEntries.includes(verification.aab) ||
      !candidateEntries.includes('manifest.json') || !candidateEntries.includes('aab.sha256')) {
    throw new Error('Candidate directory contains unexpected or missing files.');
  }
  const inputDetails = await lstat(inputPath);
  if (!inputDetails.isFile() || inputDetails.isSymbolicLink()) throw new Error('Verified AAB is not a regular file.');
  const inputDigest = await sha256File(inputPath);
  if (inputDigest !== verification.sha256) throw new Error('Unsigned AAB changed after provenance verification.');

  await requirePrivateRegularFile(keystorePath, 'Courier keystore');
  await requirePrivateRegularFile(storePasswordPath, 'Courier store password file');
  await requirePrivateRegularFile(keyPasswordPath, 'Courier key password file');
  const output = resolve(outputPath);
  if (output === inputPath) throw new Error('Signed output must not replace the verified unsigned input.');
  try {
    await lstat(output);
    throw new Error('Signed output path already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let createdOutput = false;
  try {
    createdOutput = true;
    runTool('jarsigner', [
      '-keystore', keystorePath,
      '-storetype', 'PKCS12',
      '-storepass:file', storePasswordPath,
      '-keypass:file', keyPasswordPath,
      '-signedjar', output,
      inputPath,
      keyAlias,
    ]);
    const verifyOutput = runTool('jarsigner', ['-verify', '-certs', output]);
    if (!/jar verified\./i.test(verifyOutput)) throw new Error('JAR signature verification did not report a verified bundle.');
    const certificateOutput = runTool('keytool', ['-printcert', '-rfc', '-jarfile', output]);
    const certificates = [...certificateOutput.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
    const fingerprints = certificates.map((match) => normalizedFingerprint(new X509Certificate(match[0]).fingerprint256));
    if (fingerprints.length !== 1 || fingerprints[0] !== normalizedFingerprint(expectedCertificateSha256)) {
      throw new Error('Signed bundle certificate does not match the approved Courier upload certificate.');
    }

    const signedInspection = inspect(output, bundletoolJar);
    if (!signedInspection.hasRequiredStructure || !signedInspection.hasSignature ||
        signedInspection.identity.packageName !== EXPECTED_PACKAGE ||
        Number(signedInspection.identity.versionCode) !== Number(expectedVersionCode) ||
        signedInspection.identity.versionName !== expectedVersionName) {
      throw new Error('Signed bundle structure or package/version identity is invalid.');
    }
    if (await sha256File(inputPath) !== inputDigest) throw new Error('Unsigned input changed during signing.');
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size < 1) throw new Error('Signed bundle output is empty.');
    return {
      aab: output,
      packageName: EXPECTED_PACKAGE,
      versionCode: Number(expectedVersionCode),
      versionName: expectedVersionName,
      sourceSha,
      buildRunId: String(buildRunId),
      buildRunAttempt: String(buildRunAttempt),
      unsignedSha256: inputDigest,
      signedSha256: await sha256File(output),
      certificateSha256: fingerprints[0],
    };
  } catch (error) {
    if (createdOutput) await unlink(output).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [artifactDir, verificationPath, outputPath, keystorePath, storePasswordPath, keyPasswordPath,
    bundletoolJar, sourceSha, buildRunId, buildRunAttempt, expectedVersionCode, expectedVersionName,
    expectedCertificateSha256] = process.argv.slice(2);
  if (![artifactDir, verificationPath, outputPath, keystorePath, storePasswordPath, keyPasswordPath,
    bundletoolJar, sourceSha, buildRunId, buildRunAttempt, expectedVersionCode, expectedVersionName,
    expectedCertificateSha256].every(Boolean)) {
    throw new Error('Signing inputs are incomplete.');
  }
  if (normalizedFingerprint(expectedCertificateSha256) !== COURIER_UPLOAD_CERTIFICATE_SHA256) {
    throw new Error('Configured Courier upload certificate does not match the approved fingerprint.');
  }
  const result = await signAndVerifyCourierBundle({
    artifactDir, verificationPath, outputPath, keystorePath, storePasswordPath, keyPasswordPath, bundletoolJar,
    sourceSha, buildRunId, buildRunAttempt, expectedVersionCode: Number(expectedVersionCode),
    expectedVersionName,
    expectedCertificateSha256: COURIER_UPLOAD_CERTIFICATE_SHA256,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
