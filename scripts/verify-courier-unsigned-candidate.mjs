import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE = 'com.linago.courier';
const SIGNATURE_ENTRY = /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i;

export function parseBundleIdentity(xml) {
  const get = (name) => {
    const match = xml.match(new RegExp(`${name}="([^"]+)"`));
    if (!match) throw new Error(`Bundle manifest is missing ${name}.`);
    return match[1];
  };
  const versionCode = Number(get('android:versionCode'));
  const identity = {
    packageName: get('package'),
    versionCode,
    versionName: get('android:versionName'),
  };
  if (identity.packageName !== EXPECTED_PACKAGE || !Number.isSafeInteger(versionCode) || versionCode < 1 || !identity.versionName) {
    throw new Error('Courier bundle identity is invalid.');
  }
  return identity;
}

export async function verifyCandidate({ artifactDir, sourceSha, buildRunId, expectedBuildWorkflowSha, expectedRunAttempt, expectedVersionCode, expectedVersionName, bundletoolJar }) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  assert.match(String(buildRunId), /^[0-9]+$/);
  assert.match(expectedBuildWorkflowSha, /^[0-9a-f]{40}$/);
  assert.match(String(expectedRunAttempt), /^[0-9]+$/);
  const root = resolve(artifactDir);
  const names = await readdir(root);
  if (names.length !== 3 || !names.includes('manifest.json') || !names.includes('aab.sha256')) {
    throw new Error('Candidate must contain exactly one AAB, its digest, and manifest.');
  }

  const metadata = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (metadata.sourceSha !== sourceSha || String(metadata.buildRunId) !== String(buildRunId)) {
    throw new Error('Candidate provenance does not match the requested source and build run.');
  }
  if (metadata.buildWorkflowSha !== expectedBuildWorkflowSha || String(metadata.buildRunAttempt) !== String(expectedRunAttempt)) {
    throw new Error('Candidate was produced by a different workflow commit or run attempt.');
  }
  if (metadata.buildWorkflow !== '.github/workflows/courier-unsigned-release-candidate.yml') {
    throw new Error('Candidate was not produced by the approved Courier build workflow.');
  }
  if (metadata.packageName !== EXPECTED_PACKAGE || metadata.signed !== false) {
    throw new Error('Candidate package or unsigned state is unexpected.');
  }
  if (metadata.versionCode !== expectedVersionCode || metadata.versionName !== expectedVersionName) {
    throw new Error('Candidate version differs from the approved source metadata.');
  }
  if (typeof metadata.aab !== 'string' || basename(metadata.aab) !== metadata.aab || !metadata.aab.endsWith('.aab')) {
    throw new Error('Candidate AAB filename is invalid.');
  }

  const aabPath = join(root, metadata.aab);
  const stat = await lstat(aabPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate AAB must be a regular file.');
  const bytes = await readFile(aabPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== metadata.aabSha256) throw new Error('AAB SHA-256 differs from its manifest.');
  const sidecar = (await readFile(join(root, 'aab.sha256'), 'utf8')).trim();
  if (sidecar !== `${digest}  ${metadata.aab}`) throw new Error('AAB SHA-256 differs from its sidecar.');

  const entries = execFileSync('jar', ['tf', aabPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => SIGNATURE_ENTRY.test(entry))) throw new Error('Candidate must be unsigned before the protected signing stage.');
  if (!entries.includes('BundleConfig.pb') || !entries.includes('base/manifest/AndroidManifest.xml')) {
    throw new Error('Candidate is missing required Android App Bundle entries.');
  }

  execFileSync('java', ['-jar', bundletoolJar, 'validate', `--bundle=${aabPath}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const xml = execFileSync('java', ['-jar', bundletoolJar, 'dump', 'manifest', `--bundle=${aabPath}`, '--module=base'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const actual = parseBundleIdentity(xml);
  if (actual.versionCode !== expectedVersionCode || actual.versionName !== expectedVersionName) {
    throw new Error('AAB manifest version differs from the approved source metadata.');
  }
  return { ...actual, sha256: digest, aab: metadata.aab, sourceSha, buildRunId: String(buildRunId) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [artifactDir, sourceSha, buildRunId, buildWorkflowSha, runAttempt, expectedCode, expectedName, bundletoolJar] = process.argv.slice(2);
  if (![artifactDir, sourceSha, buildRunId, buildWorkflowSha, runAttempt, expectedCode, expectedName, bundletoolJar].every(Boolean)) {
    throw new Error('Usage: verify-courier-unsigned-candidate.mjs <dir> <source-sha> <build-run-id> <build-workflow-sha> <run-attempt> <version-code> <version-name> <bundletool-jar>');
  }
  const result = await verifyCandidate({
    artifactDir,
    sourceSha,
    buildRunId,
    expectedBuildWorkflowSha: buildWorkflowSha,
    expectedRunAttempt: runAttempt,
    expectedVersionCode: Number(expectedCode),
    expectedVersionName: expectedName,
    bundletoolJar,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
