#!/usr/bin/env node
/**
 * r2-smoke.mjs — validate the R2 client (SigV4 signer + gzip round-trip) against
 * a real bucket before wiring it into a live scan. Writes one tiny test object
 * under raw/_smoke/, HEADs it, GETs it back, and checks the round-trip.
 *
 * Usage:  node --env-file=.env scripts/r2-smoke.mjs
 *   env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { isEnabled, putGzipJson, objectExists, getGzipJson, contentHash } from '../src/r2.mjs';

if (!isEnabled()) {
  console.error('R2 not configured. Need R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET.');
  process.exit(1);
}

const payload = JSON.stringify({
  smoke: true,
  ts: new Date().toISOString(),
  jobs: [{ id: 1, title: 'Test Engineer' }, { id: 2, title: 'Staff Test Engineer' }],
});
const hash = contentHash(payload);
const key = `raw/_smoke/${hash}.json.gz`;

console.log(`PUT  ${key}`);
const { bytes } = await putGzipJson(key, payload);
console.log(`     stored ${bytes} gzipped bytes (from ${Buffer.byteLength(payload)} raw)`);

const exists = await objectExists(key);
console.log(`HEAD exists? ${exists}`);

const back = await getGzipJson(key);
const ok = back === payload;
console.log(`GET  round-trip match: ${ok}`);

if (!exists || !ok) {
  console.error('\nR2 SMOKE TEST FAILED');
  process.exit(1);
}
console.log('\nR2 smoke test PASSED — signer + gzip round-trip verified.');
console.log(`(left ${key} in the bucket; safe to delete)`);
