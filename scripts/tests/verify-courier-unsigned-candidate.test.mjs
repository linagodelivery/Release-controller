import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBundleIdentity, verifyCandidate } from '../verify-courier-unsigned-candidate.mjs';

async function fixture(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'courier-candidate-'));
  const bytes = Buffer.from('unsigned-aab-fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(dir, 'candidate.aab'), bytes);
  await writeFile(join(dir, 'aab.sha256'), `${digest}  candidate.aab\n`);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    sourceSha: 'a'.repeat(40), buildRunId: '1234', buildWorkflowSha: 'c'.repeat(40), buildRunAttempt: '1',
    buildWorkflow: '.github/workflows/courier-unsigned-release-candidate.yml',
    packageName: 'com.linago.courier', versionCode: 59, versionName: '1.0.2',
    aab: 'candidate.aab', aabSha256: digest, signed: false,
    ...overrides,
  }));
  return dir;
}

const params = (dir, overrides = {}) => ({ artifactDir: dir, sourceSha: 'a'.repeat(40), buildRunId: '1234', expectedBuildWorkflowSha: 'c'.repeat(40), expectedRunAttempt: '1', expectedVersionCode: 59, expectedVersionName: '1.0.2', bundletoolJar: 'unused', ...overrides });

test('rejects a different source commit before inspecting a bundle', async () => {
  const dir = await fixture();
  try { await assert.rejects(verifyCandidate(params(dir, { sourceSha: 'b'.repeat(40) })), /provenance/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects a different build run before inspecting a bundle', async () => {
  const dir = await fixture();
  try { await assert.rejects(verifyCandidate(params(dir, { buildRunId: '5678' })), /provenance/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects a different workflow commit or run attempt', async (t) => {
  for (const overrides of [{ expectedBuildWorkflowSha: 'd'.repeat(40) }, { expectedRunAttempt: '2' }]) {
    await t.test('provenance mismatch', async () => {
      const dir = await fixture();
      try { await assert.rejects(verifyCandidate(params(dir, overrides)), /workflow commit or run attempt/); }
      finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});

test('rejects a package, version, and signed-state mismatch', async (t) => {
  for (const [label, override, expected] of [
    ['package', { packageName: 'com.other.app' }, /package/],
    ['version', { versionCode: 58 }, /version/],
    ['signed', { signed: true }, /unsigned/],
  ]) {
    await t.test(label, async () => {
      const dir = await fixture(override);
      try { await assert.rejects(verifyCandidate(params(dir)), expected); }
      finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});

test('rejects a different artifact digest', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'aab.sha256'), `${'0'.repeat(64)}  candidate.aab\n`);
    await assert.rejects(verifyCandidate(params(dir)), /sidecar/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects ambiguous artifact contents', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'unexpected.aab'), 'other');
    await assert.rejects(verifyCandidate(params(dir)), /exactly one AAB/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parses Courier package and version from bundletool manifest output', () => {
  assert.deepEqual(parseBundleIdentity('<manifest package="com.linago.courier" android:versionCode="59" android:versionName="1.0.2">'), {
    packageName: 'com.linago.courier', versionCode: 59, versionName: '1.0.2',
  });
  assert.throws(() => parseBundleIdentity('<manifest package="com.other" android:versionCode="59" android:versionName="1.0.2">'), /identity is invalid/);
});
