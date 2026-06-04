#!/usr/bin/env node
/**
 * Minimal resume→jobs matcher web app. Zero server-side dependencies: Node's
 * built-in http + the existing matching modules.
 *
 *   GET  /            → public/index.html (upload UI; PDF parsed in-browser)
 *   GET  /<asset>     → static files under public/
 *   POST /api/match   → { resumeText } → { title, matches[], reranked, retrieved }
 *
 * The browser extracts résumé text (pdf.js) and posts plain text, so the
 * server never touches binary uploads. Pipeline: resume text → JD-style precis
 * (src/resume-to-jd.mjs) → embed (text-embedding-3-small) → two-stage matcher
 * (src/match-resume.mjs: cosine retrieve + gpt-4o-mini rerank).
 *
 * Run:  node --env-file=.env src/web-server.mjs   (or: npm run web)
 *   env: PORT (3000), MATCH_CANDIDATES (40), MATCH_TOPK (15)
 *
 * This is a local/demo single-user tool — no auth, no rate limiting. Don't
 * expose it to the public internet as-is (it spends OpenAI tokens per request).
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resumeToJd } from './resume-to-jd.mjs';
import { embedTexts } from './embeddings.mjs';
import { matchResume } from './match-resume.mjs';

const PORT = Number(process.env.PORT || 3000);
const CANDIDATES = Number(process.env.MATCH_CANDIDATES || 40);
const TOPK = Number(process.env.MATCH_TOPK || 15);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 1_000_000; // 1 MB of resume text is plenty

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Trim each candidate down to a clean display payload for the UI.
function toMatch(c) {
  const comp = c.comp_min != null || c.comp_max != null
    ? `${c.comp_currency || ''}${c.comp_min ?? ''}${c.comp_max != null && c.comp_max !== c.comp_min ? '–' + c.comp_max : ''}`.trim()
    : null;
  return {
    title: c.title, company: c.company, location: c.location, remote: c.remote,
    comp, posted: c.posted, url: c.url,
    fit: c.rerank_score, cosine: c.cosine_sim,
    why: (c.description_summary || '').split('\n').find((l) => /^Role:/i.test(l))?.replace(/^Role:\s*/i, '') || null,
  };
}

async function handleMatch(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: e.message === 'Payload too large' ? e.message : 'Invalid JSON body' });
  }
  const resumeText = (payload.resumeText || '').toString();
  if (resumeText.trim().length < 30) {
    return send(res, 400, { error: 'Could not read enough résumé text. Try another file or paste the text.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, { error: 'Server missing OPENAI_API_KEY.' });
  }

  try {
    const t0 = Date.now();
    const { jdText, title } = await resumeToJd(resumeText);
    const [vec] = await embedTexts([jdText]);
    const { candidates, reranked, retrieved } = await matchResume({
      resumeVec: vec, resumeText: jdText, topK: TOPK, candidateCount: CANDIDATES,
    });
    return send(res, 200, {
      title, reranked, retrieved, tookMs: Date.now() - t0,
      matches: candidates.map(toMatch),
    });
  } catch (e) {
    console.error('match error:', e.message);
    return send(res, 500, { error: 'Matching failed: ' + e.message });
  }
}

async function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  // Prevent path traversal: resolve and ensure it stays under PUBLIC_DIR.
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/match') return handleMatch(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`resume matcher running →  http://localhost:${PORT}`);
  console.log(`  retrieve ${CANDIDATES} → rerank → top ${TOPK}  ${process.env.OPENAI_API_KEY ? '(rerank on)' : '(NO OPENAI_API_KEY — will error)'}`);
});
