# fyj_scanner status page

A minimal Next.js 15 dashboard that visualises the scanner's SLA and recent runs by reading from Supabase. Server-rendered — no JavaScript needed in the browser, auto-refreshes every 30s via meta refresh.

## Pages

| Path | What it shows |
|---|---|
| `/` (Overview) | Three SLA tiles, per-source health (24h/7d/30d toggle), three charts (active jobs, new per scan, closed per scan), recent scans |
| `/jobs` | Searchable job list — title contains, ATS filter, active-only toggle, paginated 50/page |
| `/matches` | Upload a résumé (PDF, parsed in-browser) → top live job matches. Two-stage: cosine retrieve → gpt-4o-mini rerank. Needs `VOYAGE_API_KEY` (embedding, `voyage-4-large` @ 1024d — must match the scanner) + `OPENAI_API_KEY` (JD-precis + rerank). |
| `/scans` | Paginated scan history with status filter (all/ok/failed/running) |
| `/scans/[id]` | Single scan — summary tiles, top error reasons, all probe results with filter pills (all/failed/blocked/slowest) |
| `/companies` | Companies table — slug search, ATS filter, state filter (enabled/disabled/errored), sorted by error count |

All filters live in the URL (`?q=...&ats=...&page=...`) so views are shareable.

## Run locally

```bash
cd status-page
cp .env.example .env.local
# Edit .env.local with your Supabase URL + service-role key
npm install
npm run dev
```

Open <http://localhost:3000>.

## Deploy to Vercel

1. New project in Vercel → import this repo.
2. **Root Directory** → set to `status-page`.
3. Environment variables → add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (plus `VOYAGE_API_KEY` + `OPENAI_API_KEY` for the `/matches` page).
4. Deploy.

Vercel auto-detects Next.js; no build config needed.

## Access control

The page is public unless you protect it. The service-role key never reaches the browser (it's read only in Server Components in `app/page.jsx`), but the rendered HTML is reachable by anyone who knows the URL.

To restrict:

- **Easiest:** Vercel project → Settings → Deployment Protection → password-protect Production. Free on Hobby.
- **Stricter:** swap to `SUPABASE_ANON_KEY` and add a read-only RLS policy on each view used here.

## Why no charting library?

Adding Recharts/Chart.js for one sparkline pulls ~150kB of JS. The inline SVG sparkline in [app/page.jsx](app/page.jsx) is ~30 lines and renders server-side — zero client JS.

## File map

```
app/
  globals.css         Tailwind v4 entry
  layout.jsx          Dark shell + Nav
  page.jsx            Overview: SLA tiles + per-source + charts + recent scans
  jobs/page.jsx       Job search with filters + pagination
  scans/page.jsx      Paginated scan list
  scans/[id]/page.jsx Scan detail with probe-result filtering
  companies/page.jsx  Company search with filters + pagination
components/
  Nav.jsx             Client component (usePathname for active tab)
  ui.jsx              Sla, Sparkline, Bars, Badge, Th, Td, Empty, Pagination, RangePills
lib/
  supabase.js         PostgREST helpers — pgSelect, pgSelectRange, pgCount, pgRpc
```
