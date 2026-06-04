import ResumeMatcher from '../../components/ResumeMatcher';

export const metadata = { title: 'Resume matches · fyj_scanner' };
export const dynamic = 'force-dynamic';

export default function MatchesPage() {
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Resume matches</h1>
        <span className="text-xs text-zinc-500">cosine retrieve → gpt-4o-mini rerank</span>
      </header>
      <p className="text-sm text-zinc-400">
        Upload a résumé to find the best live job matches in the index. The PDF is parsed in your browser;
        the server turns it into a structured profile, embeds it, and reranks the closest postings by fit.
      </p>
      <ResumeMatcher />
    </main>
  );
}
