/**
 * Job fingerprinting.
 *
 * Used by v_unique_active_jobs to collapse the "same role, new posting ID"
 * case within a company (job closes, then gets re-listed under a new ID).
 *
 * Algorithm (v1):
 *   md5( lowercase( whitespace-collapse( title + '|' + location ) ) )
 *
 * Bump the version constant if you change the algo — old rows will keep
 * their old fingerprint until they're touched by a scan, which is fine:
 * dedup just won't fire across the version boundary.
 */

import { createHash } from 'crypto';

export const FINGERPRINT_VERSION = 1;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(title, location) {
  const key = `${normalize(title)}|${normalize(location)}`;
  return createHash('md5').update(key).digest('hex');
}
