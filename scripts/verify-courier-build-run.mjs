import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const OWNER = 'linagodelivery';
const REPOSITORY = 'Delivery';
const REPOSITORY_ID = 1121364665;
const API_VERSION = '2022-11-28';
const POLICY_PATH = new URL('./courier-build-workflow-policy.json', import.meta.url);

export function parseUniqueGradleValue(contents, key, pattern, label = key) {
  const matches = [...contents.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Selected source must define exactly one ${label}.`);
  return matches[0][1];
}

export function parseCourierGradleIdentity(contents) {
  const applicationId = parseUniqueGradleValue(contents, 'applicationId', /^\s*applicationId\s*=\s*"([^"]+)"\s*$/gm, 'application ID');
  const codeText = parseUniqueGradleValue(contents, 'versionCode', /^\s*versionCode\s*=\s*(\d+)\s*$/gm, 'versionCode');
  const versionName = parseUniqueGradleValue(contents, 'versionName', /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'versionName');
  const versionCode = Number(codeText);
  if (applicationId !== 'com.linago.courier' || !Number.isSafeInteger(versionCode) || versionCode < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(versionName)) {
    throw new Error('Selected source has invalid Courier application or version metadata.');
  }
  return { applicationId, versionCode, versionName };
}

export function verifyCurrentMainSource(sourceSha, mainCommitSha) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '') || !/^[0-9a-f]{40}$/.test(mainCommitSha ?? '') || sourceSha !== mainCommitSha) {
    throw new Error('Selected Delivery source must be the current main commit; rebuild the candidate after main advances.');
  }
  return true;
}

export function verifyBuildExecution({ run, attempt, workflow, workflowSha256, sourceSha, requestedAttempt, artifacts, policy }) {
  assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
  assert.match(String(requestedAttempt ?? ''), /^[1-9]\d{0,5}$/);
  if (!run || !attempt || !workflow || !policy || !Array.isArray(artifacts) ||
      !Number.isSafeInteger(run.id) || run.id < 1 || String(run.id) !== String(attempt.id) ||
      Number(run.run_attempt) !== Number(requestedAttempt) || Number(attempt.run_attempt) !== Number(requestedAttempt)) {
    throw new Error('Requested run attempt does not match authoritative GitHub run metadata.');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success' || attempt.status !== 'completed' || attempt.conclusion !== 'success') {
    throw new Error('The selected workflow run attempt did not complete successfully.');
  }
  if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || (run.ref && run.ref !== 'refs/heads/main')) {
    throw new Error('Build must be a manual workflow run from protected main.');
  }
  if (run.repository?.id !== REPOSITORY_ID || run.repository?.full_name !== `${OWNER}/${REPOSITORY}` ||
      run.head_repository?.id !== REPOSITORY_ID || run.head_repository?.full_name !== `${OWNER}/${REPOSITORY}`) {
    throw new Error('Build run repository identity is not the canonical private Delivery repository.');
  }
  if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? '') || run.head_sha !== sourceSha || attempt.head_sha !== run.head_sha) {
    throw new Error('Selected source SHA must exactly match the successful build run head SHA.');
  }
  if (run.path !== policy.workflowPath ||
      workflow?.path !== policy.workflowPath || Number(workflow?.id) !== Number(run.workflow_id) || workflow?.state !== 'active') {
    throw new Error('GitHub run and workflow metadata do not identify the approved build workflow.');
  }
  if (policy.sourcePolicy !== 'must-equal-workflow-run-head' || policy.applicationId !== 'com.linago.courier') {
    throw new Error('Controller build policy is missing or invalid.');
  }
  if (!/^[0-9a-f]{64}$/.test(workflowSha256 ?? '') || workflowSha256 !== policy.approvedWorkflowSha256) {
    throw new Error('Executed-run workflow file content is not on the controller-approved digest allowlist.');
  }

  const artifactName = `courier-unsigned-${sourceSha}`;
  if (!Array.isArray(artifacts) || artifacts.length > 100) throw new Error('Artifact listing is missing or exceeds the bounded verification limit.');
  const named = artifacts.filter((item) => item.name === artifactName);
  if (named.length !== 1) throw new Error('Expected exactly one candidate artifact with the source-bound name.');
  const artifact = named[0];
  const attemptStartedAt = Date.parse(attempt.run_started_at ?? '');
  const artifactCreatedAt = Date.parse(artifact.created_at ?? '');
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '') ||
      !Number.isFinite(attemptStartedAt) || !Number.isFinite(artifactCreatedAt) || artifactCreatedAt < attemptStartedAt ||
      Number(artifact.workflow_run?.id) !== Number(run.id) || artifact.workflow_run?.repository_id !== REPOSITORY_ID ||
      artifact.workflow_run?.head_repository_id !== REPOSITORY_ID || artifact.workflow_run?.head_branch !== 'main' ||
      artifact.workflow_run?.head_sha !== run.head_sha) {
    throw new Error('GitHub artifact metadata does not bind the candidate to the selected run and source.');
  }
  return { artifactName, artifactId: artifact.id, artifactDigest: artifact.digest, runId: String(run.id), runAttempt: String(requestedAttempt), runHeadSha: run.head_sha };
}

async function main() {
  const [sourceSha, runId, runAttempt] = process.argv.slice(2);
  if (!sourceSha || !runId || !runAttempt || !process.env.GH_TOKEN) throw new Error('Usage: verify-courier-build-run.mjs <source-sha> <run-id> <run-attempt> (GH_TOKEN required).');
  assert.match(String(runId), /^\d{1,20}$/);
  const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8'));
  const token = process.env.GH_TOKEN;
  async function api(path) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION },
    });
    if (!response.ok) throw new Error(`GitHub verification request failed (${response.status}).`);
    return response.json();
  }

  const run = await api(`/repos/${OWNER}/${REPOSITORY}/actions/runs/${runId}`);
  const attempt = await api(`/repos/${OWNER}/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`);
  const workflow = await api(`/repos/${OWNER}/${REPOSITORY}/actions/workflows/${run.workflow_id}`);
  const workflowContent = await api(`/repos/${OWNER}/${REPOSITORY}/contents/${encodeURIComponent(policy.workflowPath).replaceAll('%2F', '/')}?ref=${run.head_sha}`);
  if (workflowContent.type !== 'file' || typeof workflowContent.content !== 'string' || workflowContent.encoding !== 'base64') {
    throw new Error('GitHub did not return the build workflow file at the run head commit.');
  }
  const workflowBytes = Buffer.from(workflowContent.content, 'base64');
  const workflowSha256 = createHash('sha256').update(workflowBytes).digest('hex');
  const artifactResponse = await api(`/repos/${OWNER}/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(artifactResponse.artifacts) || artifactResponse.total_count !== artifactResponse.artifacts.length) {
    throw new Error('Artifact list is incomplete; refusing to verify a partial result.');
  }
  const result = verifyBuildExecution({ run, attempt, workflow, workflowSha256, sourceSha, requestedAttempt: runAttempt, artifacts: artifactResponse.artifacts, policy });

  const [compare, mainCommit] = await Promise.all([
    api(`/repos/${OWNER}/${REPOSITORY}/compare/${sourceSha}...main`),
    api(`/repos/${OWNER}/${REPOSITORY}/commits/main`),
  ]);
  if (compare.merge_base_commit?.sha !== sourceSha) throw new Error('Selected source is no longer an ancestor of Delivery main.');
  verifyCurrentMainSource(sourceSha, mainCommit.sha);
  const gradle = await api(`/repos/${OWNER}/${REPOSITORY}/contents/android/app/build.gradle.kts?ref=${sourceSha}`);
  if (gradle.type !== 'file' || gradle.encoding !== 'base64') throw new Error('Selected Courier Gradle configuration is unavailable.');
  const identity = parseCourierGradleIdentity(Buffer.from(gradle.content, 'base64').toString('utf8'));
  if (identity.applicationId !== policy.applicationId) throw new Error('Selected source has an unexpected application ID.');

  const output = {
    ...result,
    ...identity,
    workflowSha256,
    workflowDefinitionCommit: run.head_sha,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
