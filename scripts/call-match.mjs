#!/usr/bin/env node
// Call the match_resume RPC with the embedding from scripts/_resume.vec.
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL or SERVICE_ROLE_KEY missing');

const vec = JSON.parse(fs.readFileSync('scripts/_resume.vec', 'utf8').trim());
if (vec.length !== 1024) throw new Error(`vec dim ${vec.length}`);

const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_resume`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify({ resume_vec: vec, match_count: 30 }),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}
const rows = await res.json();
console.error(`got ${rows.length} matches`);
console.log(JSON.stringify(rows, null, 2));
