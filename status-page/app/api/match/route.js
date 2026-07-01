import { matchResume } from '../../../lib/match';

// Node runtime: needs the service-role + Voyage + OpenAI keys and longer than the
// edge budget (cosine retrieve + ~40 rerank calls ≈ 8-12s).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY = 1_000_000; // 1 MB of résumé text is plenty

export async function POST(req) {
  let resumeText = '';
  let remote, location;
  try {
    const body = await req.text();
    if (body.length > MAX_BODY) return Response.json({ error: 'Payload too large' }, { status: 413 });
    const parsed = JSON.parse(body);
    resumeText = (parsed.resumeText || '').toString();
    remote = parsed.remote;       // 'remote' | 'hybrid' | 'onsite' | undefined
    location = parsed.location;   // free-text substring
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (resumeText.trim().length < 30) {
    return Response.json({ error: 'Could not read enough résumé text. Try another file or paste the text.' }, { status: 400 });
  }
  // Embedding runs on Voyage (voyage-4-large, jobs.embedding's space); the
  // JD-precis + rerank steps run on OpenAI chat models. Both keys are required.
  const missing = ['VOYAGE_API_KEY', 'OPENAI_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    return Response.json({ error: `Server missing ${missing.join(' + ')} — set to enable matching.` }, { status: 503 });
  }
  try {
    const result = await matchResume(resumeText, { remote, location });
    return Response.json(result);
  } catch (e) {
    console.error('match error:', e.message);
    return Response.json({ error: 'Matching failed: ' + e.message }, { status: 500 });
  }
}
