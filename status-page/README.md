# fyj_scanner status page

A minimal Next.js 15 dashboard that visualises the scanner's SLA and recent runs by reading from Supabase. Server-rendered — no JavaScript needed in the browser, auto-refreshes every 30s via meta refresh.

## What you see

- **Three SLA tiles** — block rate, active job count, time since last scan. Red dot = breach.
- **Per-source health (24h)** — `v_source_health_24h`: probes, blocked, latency p50/p95 per ATS.
- **Active-jobs sparkline** — last 14 scans, SLA line drawn at 50k.
- **Recent scans table** — last 14 rows from `v_recent_scans`.

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
3. Environment variables → add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
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
  globals.css     Tailwind v4 entry
  layout.jsx      Dark shell
  page.jsx        Whole dashboard — SLA tiles, tables, sparkline
lib/
  supabase.js     Bare PostgREST helpers (pgSelect, pgCount)
```
