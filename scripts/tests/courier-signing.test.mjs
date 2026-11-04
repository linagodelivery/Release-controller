import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAndVerifyCourierBundle } from '../sign-courier-aab.mjs';
import { uploadCourierAab } from '../upload-courier-signed-aab.mjs';

const sourceSha = 'a'.repeat(40);
const versionCode = 59;
const versionName = '1.0.2';
const buildRunId = '12345';
const buildRunAttempt = '1';
const expectedIdentity = { packageName: 'com.linago.courier', versionCode, versionName };
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = join(repoRoot, '.github', 'workflows', 'courier-sign.yml');

function listJarEntries(path) {
  return execFileSync('jar', ['tf', path], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

const inspectSyntheticAab = (path) => {
  const entries = listJarEntries(path);
  const hasSignature = entries.some((entry) => /^META-INF\/[^/]+\.SF$/i.test(entry)) &&
    entries.some((entry) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(entry));
  return {
    hasRequiredStructure: entries.includes('BundleConfig.pb') && entries.includes('base/manifest/AndroidManifest.xml'),
    hasSignature,
    identity: expectedIdentity,
  };
};

async function signingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'courier-signing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateDir = join(root, 'candidate');
  const contents = join(root, 'contents');
  await mkdir(candidateDir);
  await mkdir(join(contents, 'base', 'manifest'), { recursive: true });
  await writeFile(join(contents, 'BundleConfig.pb'), Buffer.from([0x0a, 0x00]));
  await writeFile(join(contents, 'base', 'manifest', 'AndroidManifest.xml'), '<synthetic manifest fixture/>');
  const aabName = 'courier-candidate.aab';
  const aabPath = join(candidateDir, aabName);
  execFileSync('jar', ['--create', '--file', aabPath, '-C', contents, 'BundleConfig.pb', '-C', contents, 'base/manifest/AndroidManifest.xml']);
  const inputBytes = await readFile(aabPath);
  const digest = createHash('sha256').update(inputBytes).digest('hex');
  await writeFile(join(candidateDir, 'aab.sha256'), `${digest}  ${aabName}\n`);
  await writeFile(join(candidateDir, 'manifest.json'), JSON.stringify({
    aab: aabName, aabSha256: digest, sourceSha, buildRunId, buildRunAttempt,
    packageName: expectedIdentity.packageName, versionCode, versionName, signed: false,
  }));
  const verificationPath = join(root, 'verified-candidate.json');
  await writeFile(verificationPath, JSON.stringify({
    ...expectedIdentity, sha256: digest, aab: aabName, sourceSha, buildRunId, buildRunAttempt,
  }));
  const secretDir = join(root, 'credentials');
  await mkdir(secretDir);
  const storePasswordPath = join(secretDir, 'store-password');
  const keyPasswordPath = join(secretDir, 'key-password');
  await writeFile(storePasswordPath, 'dummy-test-only-password');
  await writeFile(keyPasswordPath, 'dummy-test-only-password');
  const keystorePath = join(secretDir, 'dummy.p12');
  execFileSync('keytool', [
    '-genkeypair', '-alias', 'linago-courier-upload', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
    '-storetype', 'PKCS12', '-keystore', keystorePath, '-storepass:file', storePasswordPath,
    '-keypass:file', keyPasswordPath, '-dname', 'CN=Dummy Courier Test Certificate',
  ], { stdio: 'ignore' });
  const pem = execFileSync('keytool', [
    '-exportcert', '-rfc', '-alias', 'linago-courier-upload', '-keystore', keystorePath,
    '-storetype', 'PKCS12', '-storepass:file', storePasswordPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const certificateSha256 = new X509Certificate(pem).fingerprint256.replaceAll(':', '');
  const outputPath = join(root, 'courier-signed.aab');
  const base = {
    artifactDir: candidateDir, verificationPath, outputPath, keystorePath, storePasswordPath, keyPasswordPath,
    bundletoolJar: 'unused-by-synthetic-inspector', sourceSha, buildRunId, buildRunAttempt,
    expectedVersionCode: versionCode, expectedVersionName: versionName,
    expectedCertificateSha256: certificateSha256, inspect: inspectSyntheticAab,
  };
  return { root, candidateDir, aabPath, inputBytes, outputPath, keystorePath, storePasswordPath, keyPasswordPath, verificationPath, certificateSha256, base };
}

test('dummy Courier AAB signs, verifies, preserves identity, and leaves unsigned input unchanged', async (t) => {
  const fixture = await signingFixture(t);
  const result = await signAndVerifyCourierBundle(fixture.base);
  assert.equal(result.packageName, 'com.linago.courier');
  assert.equal(result.versionCode, versionCode);
  assert.equal(result.versionName, versionName);
  assert.equal(result.certificateSha256, fixture.certificateSha256);
  assert.equal(result.unsignedSha256.length, 64);
  assert.equal(result.signedSha256.length, 64);
  assert.deepEqual(await readFile(fixture.aabPath), fixture.inputBytes);
  assert.ok(listJarEntries(fixture.outputPath).some((entry) => entry.endsWith('.SF')));
});

test('rejects incorrect expected certificate and removes partial signed output', async (t) => {
  const fixture = await signingFixture(t);
  await assert.rejects(signAndVerifyCourierBundle({ ...fixture.base, expectedCertificateSha256: '0'.repeat(64) }), /certificate/);
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
});

test('rejects wrong password without leaving a signed artifact', async (t) => {
  const fixture = await signingFixture(t);
  await writeFile(fixture.storePasswordPath, 'wrong-dummy-password');
  await assert.rejects(signAndVerifyCourierBundle(fixture.base), /jarsigner failed/);
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
});

test('rejects an incorrect keystore alias without leaving a signed artifact', async (t) => {
  const fixture = await signingFixture(t);
  await assert.rejects(signAndVerifyCourierBundle({ ...fixture.base, keyAlias: 'not-the-courier-alias' }), /jarsigner failed/);
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
});

test('rejects stale or mismatched source/run/version metadata before signing', async (t) => {
  const fixture = await signingFixture(t);
  await assert.rejects(signAndVerifyCourierBundle({ ...fixture.base, sourceSha: 'b'.repeat(40) }), /metadata differs/);
  await assert.rejects(signAndVerifyCourierBundle({ ...fixture.base, buildRunAttempt: '2' }), /metadata differs/);
  await assert.rejects(signAndVerifyCourierBundle({ ...fixture.base, expectedVersionCode: 58 }), /metadata differs/);
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
});

test('rejects invalid package/version returned by trusted bundle inspection', async (t) => {
  const fixture = await signingFixture(t);
  await assert.rejects(signAndVerifyCourierBundle({
    ...fixture.base,
    inspect: (path) => ({ ...inspectSyntheticAab(path), identity: { ...expectedIdentity, packageName: 'com.other.app' } }),
  }), /structure or package\/version identity/);
  await assert.rejects(readFile(fixture.outputPath), { code: 'ENOENT' });
});

test('private Storage upload requests create-only generation precondition and returns generation metadata', async (t) => {
  const fixture = await signingFixture(t);
  const signed = await signAndVerifyCourierBundle(fixture.base);
  const records = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const key = `${url.searchParams.get('name')}`;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.headers.authorization !== 'Bearer dummy-access-token-for-test') {
        response.writeHead(401).end();
      } else if (request.headers['x-goog-hash'] !== `md5=${createHash('md5').update(Buffer.concat(chunks)).digest('base64')}`) {
        response.writeHead(400).end();
      } else if (url.searchParams.get('ifGenerationMatch') !== '0') {
        response.writeHead(400).end();
      } else if (records.has(key)) {
        response.writeHead(412).end();
      } else {
        const bytes = Buffer.concat(chunks);
        records.set(key, bytes);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          bucket: 'linago-courier-releases', name: key, generation: '1730740000000000', size: String(bytes.length),
          md5Hash: createHash('md5').update(bytes).digest('base64'),
        }));
      }
    });
  });
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  t.after(() => new Promise((resolveServer) => server.close(resolveServer)));
  const address = server.address();
  const options = {
    aabPath: signed.aab, sourceSha, buildRunId, buildRunAttempt, versionCode, bucket: 'linago-courier-releases',
    accessToken: async () => 'dummy-access-token-for-test', apiBase: `http://127.0.0.1:${address.port}/upload/storage/v1`,
  };
  const result = await uploadCourierAab(options);
  assert.equal(result.generation, '1730740000000000');
  assert.equal(result.sha256, signed.signedSha256);
  assert.match(result.object, new RegExp(`^courier/${sourceSha}/run-${buildRunId}-attempt-${buildRunAttempt}/v${versionCode}/`));
  await assert.rejects(uploadCourierAab(options), /already exists/);
  assert.equal(records.size, 1);
});

test('workflow pins all three Secret Manager versions and has no publishing/deployment action', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.equal((workflow.match(/gcloud secrets versions access 1\b/g) ?? []).length, 1);
  for (const secret of ['courier-signing-keystore', 'courier-signing-store-password', 'courier-signing-key-password']) assert.ok(workflow.includes(secret));
  const uploader = await readFile(new URL('../upload-courier-signed-aab.mjs', import.meta.url), 'utf8');
  assert.ok(uploader.includes("url.searchParams.set('ifGenerationMatch', '0')"));
  assert.ok(!/play (?:upload|publish)|firebase deploy|upload-artifact@/i.test(workflow));
  assert.ok(workflow.includes('environment: courier-sign'));
  assert.ok(workflow.includes('id-token: write'));
  assert.ok(workflow.includes("java-version: '21.0.13.0.2+1'"));
  assert.ok(workflow.includes('if: always()'));
  assert.ok(workflow.includes('"$RUNNER_TEMP/courier-signing"'));
  assert.ok(workflow.indexOf('Validate unsigned AAB before requesting Google credentials') < workflow.indexOf('Authenticate to the existing Courier WIF identity'));
  assert.ok(workflow.indexOf('Authenticate to the existing Courier WIF identity') < workflow.indexOf('Retrieve pinned Courier signing secret versions'));
});
