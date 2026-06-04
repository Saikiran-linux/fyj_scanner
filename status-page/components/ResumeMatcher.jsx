'use client';

import { useState, useRef, useCallback } from 'react';
import { Badge } from './ui';

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

// Lazy-load pdf.js from the CDN at click time (kept out of the bundle so the
// dashboard stays light). webpack/turbopack ignore so the URL import survives.
async function extractPdf(file) {
  const pdfjs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    text += content.items.map((i) => i.str).join(' ') + '\n';
  }
  return text;
}

export default function ResumeMatcher() {
  const [resumeText, setResumeText] = useState('');
  const [pasted, setPasted] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const text = (resumeText || pasted).trim();
  const ready = text.length >= 30 && !loading;

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null); setResult(null); setStatus(`Reading ${file.name}…`);
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const t = isPdf ? await extractPdf(file) : await file.text();
      setResumeText(t); setPasted('');
      setStatus(`Loaded ${t.length.toLocaleString()} characters from ${file.name}. Click “Find matches”.`);
    } catch (e) {
      setStatus(null);
      setError('Could not read that file: ' + e.message + '. Try pasting the text instead.');
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDrag(false);
    handleFile(e.dataTransfer.files?.[0]);
  }, [handleFile]);

  const findMatches = useCallback(async () => {
    if (text.length < 30) return;
    setLoading(true); setError(null); setResult(null);
    setStatus('Embedding résumé, retrieving and reranking jobs… (~10s)');
    try {
      const res = await fetch('/api/match', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResult(data); setStatus(null);
    } catch (e) {
      setError(e.message); setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [text]);

  return (
    <div className="space-y-4">
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${drag ? 'border-sky-500 bg-zinc-900' : 'border-zinc-700 bg-zinc-900/40 hover:bg-zinc-900'}`}
      >
        <div className="text-zinc-100"><span className="text-sky-400 font-medium">Drop a PDF résumé</span> here or click to choose</div>
        <div className="text-xs text-zinc-500 mt-1">Parsed in your browser — only the extracted text is sent to the server.</div>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf,.txt" hidden
          onChange={(e) => handleFile(e.target.files?.[0])} />
      </div>

      <textarea
        value={pasted}
        onChange={(e) => { setPasted(e.target.value); setResumeText(''); }}
        placeholder="…or paste your résumé text here"
        className="w-full min-h-[90px] bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-sky-500"
      />

      <div className="flex items-center gap-3">
        <button onClick={findMatches} disabled={!ready}
          className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-default text-white text-sm font-medium px-4 py-2 rounded">
          {loading ? 'Matching…' : 'Find matches'}
        </button>
        {status && <span className="text-sm text-zinc-400">{loading && <span className="inline-block w-3 h-3 mr-2 align-[-1px] border-2 border-zinc-700 border-t-sky-400 rounded-full animate-spin" />}{status}</span>}
      </div>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">{error}</div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="text-sm text-zinc-400">
            Matched as <span className="text-zinc-100 font-medium">{result.title}</span> — top {result.matches.length} of {result.retrieved} candidates
            {' '}({result.reranked ? 'reranked by gpt-4o-mini' : 'cosine only'}, {(result.tookMs / 1000).toFixed(1)}s).
          </div>
          <div className="space-y-2">
            {result.matches.map((m, i) => (
              <div key={i} className="flex gap-4 items-start border border-zinc-800 rounded-lg p-4 hover:bg-zinc-900/40">
                <div className="w-14 shrink-0 text-center">
                  <div className="text-2xl font-bold text-zinc-100 leading-none">{m.fit ?? '—'}</div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 mt-0.5">fit</div>
                  <div className="h-1 rounded bg-zinc-800 mt-1.5 overflow-hidden">
                    <div className="h-full bg-emerald-400" style={{ width: `${m.fit ?? Math.round((m.cosine || 0) * 100)}%` }} />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-medium text-zinc-100">
                    {i + 1}.{' '}
                    {m.url ? <a href={m.url} target="_blank" rel="noopener noreferrer" className="hover:text-sky-400">{m.title}</a> : m.title}
                  </h3>
                  <div className="text-sm text-zinc-400">
                    {m.company}{m.location ? ` · ${m.location}` : ''}
                  </div>
                  {m.why && <div className="text-sm text-zinc-300 mt-1.5">{m.why}</div>}
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {m.remote && <Badge tone={m.remote === 'remote' ? 'green' : m.remote === 'hybrid' ? 'blue' : 'zinc'}>{m.remote}</Badge>}
                    {m.comp && <Badge tone="zinc">{m.comp}</Badge>}
                    {m.posted && <Badge tone="zinc">posted {m.posted}</Badge>}
                  </div>
                </div>
                {m.url && (
                  <a href={m.url} target="_blank" rel="noopener noreferrer"
                    className="shrink-0 self-center text-sky-400 hover:underline text-sm font-medium whitespace-nowrap">Apply ↗</a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
