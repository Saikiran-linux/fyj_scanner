import { matchResume } from '../../../lib/match';

// Node runtime: needs the service-role + OpenAI keys and longer than the edge
// budget (cosine retrieve + ~40 rerank calls ≈ 8-12s).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY = 1_000_000; // 1 MB of résumé text is plenty

export async function POST(req) {
  let resumeText = '';
  try {
    const body = await req.text();
    if (body.length > MAX_BODY) return Response.json({ error: 'Payload too large' }, { status: 413 });
    resumeText = (JSON.parse(body).resumeText || '').toString();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (resumeText.trim().length < 30) {
    return Response.json({ error: 'Could not read enough résumé text. Try another file or paste the text.' }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'Server missing OPENAI_API_KEY — set it to enable matching.' }, { status: 503 });
  }
  try {
    const result = await matchResume(resumeText);
    return Response.json(result);
  } catch (e) {
    console.error('match error:', e.message);
    return Response.json({ error: 'Matching failed: ' + e.message }, { status: 500 });
  }
}
