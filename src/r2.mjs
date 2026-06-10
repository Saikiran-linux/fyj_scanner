/**
 * Cloudflare R2 client — minimal S3-compatible PUT/HEAD with a hand-rolled
 * AWS SigV4 signer. Zero-dependency (node:crypto + node:zlib), matching the
 * rest of this codebase's fetch-everything style.
 *
 * Used by the scanner to archive raw ATS responses (src/scan.mjs). Writes are
 * NON-FATAL: if R2 is unreachable or misconfigured, the caller logs and the
 * scan continues — a missing archive object is acceptable, a broken scan is not.
 *
 * Config (all required to enable; absent = disabled, like SKIP_LLM_PASSES):
 *   R2_ACCOUNT_ID         Cloudflare account id (the <id>.r2.cloudflarestorage.com host)
 *   R2_ACCESS_KEY_ID      R2 API token access key
 *   R2_SECRET_ACCESS_KEY  R2 API token secret
 *   R2_BUCKET             target bucket name
 *
 * R2 specifics: region is always "auto", service is "s3", endpoint is
 * https://<account_id>.r2.cloudflarestorage.com. Path-style addressing
 * (/<bucket>/<key>) — R2 doesn't do virtual-host style for arbitrary buckets.
 */

import { createHash, createHmac } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const REGION = 'auto';
const SERVICE = 's3';

export function isEnabled() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

function config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  return {
    accountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    host: `${accountId}.r2.cloudflarestorage.com`,
  };
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding for each path segment. S3/SigV4 require the canonical URI
// to be percent-encoded EXCEPT the unreserved set and the slashes between
// segments. Our keys contain '=' (ats=greenhouse) and '/', so encode segments
// individually and rejoin with '/'.
function encodeSegment(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
function encodeKeyPath(key) {
  return key.split('/').map(encodeSegment).join('/');
}

// Build SigV4 headers for a request. Returns the headers object to send.
function sign({ method, key, payload, extraHeaders = {} }) {
  const { accessKeyId, secretAccessKey, bucket, host } = config();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${encodeSegment(bucket)}/${encodeKeyPath(key)}`;
  const payloadHash = sha256hex(payload ?? '');

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  // Canonical headers: lowercase name, trimmed value, sorted by name.
  const sortedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lc = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = sortedNames.map((n) => `${n}:${lc[n]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function endpoint(key) {
  const { host, bucket } = config();
  return `https://${host}/${encodeSegment(bucket)}/${encodeKeyPath(key)}`;
}

/**
 * HEAD an object. Returns true if it exists (200), false on 404. Throws on
 * other errors so a transient failure doesn't masquerade as "absent".
 */
export async function objectExists(key) {
  const headers = sign({ method: 'HEAD', key, payload: '' });
  const res = await fetch(endpoint(key), { method: 'HEAD', headers });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`R2 HEAD ${key} → ${res.status}`);
}

/**
 * PUT bytes to R2. `body` is a Buffer/Uint8Array. Returns { bytes }.
 * Idempotent for identical content when the key is content-addressed.
 */
export async function putObject(key, body, { contentType = 'application/octet-stream', contentEncoding } = {}) {
  const extraHeaders = { 'content-type': contentType };
  if (contentEncoding) extraHeaders['content-encoding'] = contentEncoding;
  const headers = sign({ method: 'PUT', key, payload: body, extraHeaders });
  const res = await fetch(endpoint(key), { method: 'PUT', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${key} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return { bytes: body.length };
}

/**
 * GET an object's raw bytes. Returns a Buffer, or null on 404.
 */
export async function getObject(key) {
  const headers = sign({ method: 'GET', key, payload: '' });
  const res = await fetch(endpoint(key), { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 GET ${key} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Gzip a UTF-8 string and PUT it. Convenience for archiving JSON payloads.
 * Returns { key, bytes } (bytes = compressed size).
 *
 * We store the gzipped bytes as application/gzip and deliberately do NOT set a
 * `Content-Encoding: gzip` header: that header makes some HTTP clients (Node's
 * fetch included) transparently decompress on GET, which would make replay
 * non-deterministic (sometimes gzipped, sometimes not). Instead the `.json.gz`
 * key signals the format and getGzipJson() always gunzips explicitly. DuckDB /
 * ClickHouse still decompress by extension.
 */
export async function putGzipJson(key, text) {
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  await putObject(key, gz, { contentType: 'application/gzip' });
  return { key, bytes: gz.length };
}

/**
 * GET a gzipped-JSON object and return the decompressed UTF-8 string, or null
 * on 404. The replay/re-parse entry point: feed the result to provider.parse().
 */
export async function getGzipJson(key) {
  const buf = await getObject(key);
  if (buf == null) return null;
  return gunzipSync(buf).toString('utf8');
}

// sha256 hex of a string — exported so the scanner can content-address keys
// off the exact same hash it stores in raw_archive.content_hash.
export function contentHash(text) {
  return sha256hex(Buffer.from(text, 'utf8'));
}
