import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyBuildExecution, parseCourierGradleIdentity } from '../verify-courier-build-run.mjs';

const policy = JSON.parse(await readFile(new URL('../courier-build-workflow-policy.json', import.meta.url), 'utf8'));
const sha = 'a03b6eaba920ec3b930cc2e2d3a17030040c7d48';
const runId = 41825132128;
const workflowId = 406227435;
const attemptNumber = 1;
const digest = 'sha256:2112c9ae35b202e2808970b21ff06674a7b40cd51e5068793acbb5964ad1f71c';

function fixture(overrides = {}) {
  const run = {
    id: runId,
    run_attempt: attemptNumber,
    workflow_id: workflowId,
    path: policy.workflowPath,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    repository: { id: 1121364665, full_name: 'linagodelivery/Delivery' },
    head_repository: { id: 1121364665, full_name: 'linagodelivery/Delivery' },
  };
  const attempt = { id: runId, run_attempt: attemptNumber, head_sha: sha, status: 'completed', conclusion: 'success', run_started_at: '2026-11-04T11:57:22Z' };
  const workflow = { id: workflowId, path: policy.workflowPath, state: 'active' };
  const artifact = {
    id: 13319606596,
    name: `courier-unsigned-${sha}`,
    expired: false,
    size_in_bytes: 42198274,
    digest,
    created_at: '2026-11-04T12:09:50Z',
    workflow_run: { id: runId, repository_id: 1121364665, head_repository_id: 1121364665, head_branch: 'main', head_sha: sha },
  };
  return {
    run: { ...run, ...overrides.run },
    attempt: { ...attempt, ...overrides.attempt },
    workflow: { ...workflow, ...overrides.workflow },
    workflowSha256: Object.hasOwn(overrides, 'workflowSha256') ? overrides.workflowSha256 : policy.approvedWorkflowSha256,
    sourceSha: overrides.sourceSha ?? sha,
    requestedAttempt: overrides.requestedAttempt ?? attemptNumber,
    artifacts: overrides.artifacts ?? [artifact],
    policy,
  };
}

test('accepts the observed GitHub API run shape with exact workflow, source, attempt, and artifact identity', () => {
  assert.deepEqual(verifyBuildExecution(fixture()), {
    artifactName: `courier-unsigned-${sha}`,
    artifactId: 13319606596,
    artifactDigest: digest,
    runId: String(runId),
    runAttempt: String(attemptNumber),
    runHeadSha: sha,
  });
});

test('rejects an unapproved historical workflow even when its commit is on main', () => {
  assert.throws(() => verifyBuildExecution(fixture({ workflowSha256: 'c'.repeat(64) })), /approved digest/);
  assert.throws(() => verifyBuildExecution(fixture({ workflowSha256: null })), /approved digest/);
  assert.throws(() => verifyBuildExecution(fixture({ workflowSha256: '67cf78c2caec89db3fbf37240b0917322d67c0e1d284343720d87b3f1873a54e' })), /approved digest/);
});

test('rejects a mismatched workflow definition and workflow identity', () => {
  assert.throws(() => verifyBuildExecution(fixture({ workflow: { path: '.github/workflows/other.yml' } })), /workflow metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ workflow: { id: 100 } })), /workflow metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { path: '.github/workflows/unauthorized.yml' } })), /workflow metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { path: `${policy.workflowPath}@refs/heads/feature` } })), /workflow metadata/);
});

test('rejects source SHA that differs from the successful build run head', () => {
  assert.throws(() => verifyBuildExecution(fixture({ sourceSha: 'd'.repeat(40) })), /exactly match/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { head_sha: 'd'.repeat(40) } })), /exactly match/);
});

test('rejects a different build run or failed run', () => {
  assert.throws(() => verifyBuildExecution(fixture({ attempt: { id: 5678 } })), /run attempt/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { conclusion: 'failure' } })), /successfully/);
});

test('rejects a mismatched run attempt, including stale rerun metadata', () => {
  assert.throws(() => verifyBuildExecution(fixture({ requestedAttempt: 2 })), /run attempt/);
  assert.throws(() => verifyBuildExecution(fixture({ attempt: { run_attempt: 2 } })), /run attempt/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { run_attempt: undefined } })), /run attempt/);
});

test('rejects artifacts associated with another workflow run or repository', () => {
  const artifacts = [{ ...fixture().artifacts[0], workflow_run: { ...fixture().artifacts[0].workflow_run, id: 888 } }];
  assert.throws(() => verifyBuildExecution(fixture({ artifacts })), /artifact metadata/);
  const foreign = [{ ...fixture().artifacts[0], workflow_run: { ...fixture().artifacts[0].workflow_run, repository_id: 1 } }];
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: foreign })), /artifact metadata/);
});

test('rejects missing, ambiguous, expired, or digest-mismatched artifact provenance', () => {
  const artifact = fixture().artifacts[0];
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [] })), /exactly one/);
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [artifact, artifact] })), /exactly one/);
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [{ ...artifact, expired: true }] })), /artifact metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [{ ...artifact, digest: 'not-a-digest' }] })), /artifact metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [{ ...artifact, workflow_run: undefined }] })), /artifact metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ attempt: { run_started_at: undefined } })), /artifact metadata/);
  assert.throws(() => verifyBuildExecution(fixture({ artifacts: [{ ...artifact, created_at: '2026-11-03T09:59:59Z' }] })), /artifact metadata/);
});

test('rejects non-manual, non-main and foreign repository runs', () => {
  assert.throws(() => verifyBuildExecution(fixture({ run: { event: 'pull_request' } })), /manual workflow/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { head_branch: 'feature' } })), /manual workflow/);
  assert.throws(() => verifyBuildExecution(fixture({ run: { repository: { id: 9, full_name: 'fork/Delivery' } } })), /canonical private/);
});

test('rejects ambiguous Gradle application/version declarations', () => {
  const valid = 'applicationId = "com.linago.courier"\nversionCode = 59\nversionName = "1.0.2"\n';
  assert.deepEqual(parseCourierGradleIdentity(valid), { applicationId: 'com.linago.courier', versionCode: 59, versionName: '1.0.2' });
  assert.throws(() => parseCourierGradleIdentity(`${valid}versionCode = 60\n`), /exactly one versionCode/);
  assert.throws(() => parseCourierGradleIdentity(valid.replace('com.linago.courier', 'com.other.app')), /invalid Courier application/);
});
