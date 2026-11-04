import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORAGE_API = 'https://storage.googleapis.com/upload/storage/v1';

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => { sha256.update(chunk); md5.update(chunk); });
    stream.on('error', reject);
    stream.on('end', () => resolveHash({ sha256: sha256.digest('hex'), md5: md5.digest('base64') }));
  });
}

function getAccessToken() {
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Unable to obtain the short-lived authenticated Cloud Storage token.');
  }
}

function putObject(url, headers, path, requestImpl) {
  return new Promise((resolveResponse, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const request = requestImpl(transport, url, { method: 'POST', headers }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          request.destroy();
          reject(new Error('Cloud Storage response exceeded the metadata limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', () => reject(new Error('Cloud Storage upload request failed.')));
    const stream = createReadStream(path);
    stream.on('error', () => request.destroy(new Error('Unable to read verified signed artifact.')));
    stream.pipe(request);
  });
}

export async function uploadCourierAab({
  aabPath,
  sourceSha,
  buildRunId,
  buildRunAttempt,
  versionCode,
  bucket,
  accessToken = getAccessToken,
  requestImpl = (transport, url, options, callback) => transport.request(url, options, callback),
  apiBase = STORAGE_API,
}) {
  assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
  assert.match(String(buildRunId ?? ''), /^\d{1,20}$/);
  assert.match(String(buildRunAttempt ?? ''), /^[1-9]\d{0,5}$/);
  assert.match(String(versionCode ?? ''), /^[1-9]\d{0,8}$/);
  if (bucket !== 'linago-courier-releases') throw new Error('Only the approved private Courier artifact bucket is allowed.');
  const path = resolve(aabPath);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) throw new Error('Signed AAB must be a non-empty regular file.');
  const digests = await hashFile(path);
  const size = (await stat(path)).size;
  const objectName = `courier/${sourceSha}/run-${buildRunId}-attempt-${buildRunAttempt}/v${versionCode}/courier-${sourceSha}-run-${buildRunId}-attempt-${buildRunAttempt}-v${versionCode}.aab`;
  const token = await accessToken();
  if (token.length < 20 || token.length > 4096 || token !== token.trim() || /\s/.test(token)) {
    throw new Error('Cloud Storage access token was unavailable or malformed.');
  }
  const url = new URL(`${apiBase}/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', objectName);
  url.searchParams.set('ifGenerationMatch', '0');
  url.searchParams.set('fields', 'bucket,name,generation,size,md5Hash');
  const response = await putObject(url, {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    'x-goog-hash': `md5=${digests.md5}`,
  }, path, requestImpl);
  if (response.status !== 200) {
    const reason = response.status === 412 ? 'destination object already exists; overwrite was prevented' : `HTTP ${response.status}`;
    throw new Error(`Cloud Storage create-only upload failed (${reason}).`);
  }
  let metadata;
  try { metadata = JSON.parse(response.body); } catch { throw new Error('Cloud Storage returned invalid object metadata.'); }
  if (metadata.bucket !== bucket || metadata.name !== objectName || !/^\d+$/.test(String(metadata.generation ?? '')) ||
      String(metadata.size) !== String(size) || metadata.md5Hash !== digests.md5) {
    throw new Error('Cloud Storage response did not identify the exact uploaded object.');
  }
  return { bucket, object: objectName, generation: String(metadata.generation), size, sha256: digests.sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [aabPath, sourceSha, buildRunId, buildRunAttempt, versionCode, bucket] = process.argv.slice(2);
  if (![aabPath, sourceSha, buildRunId, buildRunAttempt, versionCode, bucket].every(Boolean)) {
    throw new Error('Cloud Storage upload inputs are incomplete.');
  }
  const result = await uploadCourierAab({ aabPath, sourceSha, buildRunId, buildRunAttempt, versionCode: Number(versionCode), bucket });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
