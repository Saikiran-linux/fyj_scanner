# Build brief: AI-first staffing operator dashboard (clickable mockup)

> **How to use this file:** Hand it to a fresh Claude (Claude Code, or claude.ai)
> with the prompt *"Build the mockup described in this file."* It is
> self-contained — no other repo files are needed. The goal is a **clickable,
> front-end-only mockup with realistic fake data** to validate the product
> shape before we wire it to the real backend. **Do not build auth, a database,
> or live ATS submission.** Hardcode fixtures.

---

## 1. What we're building

**fyj** is an AI-first staffing agency. We run a daily scanner that maintains a
~100k-job index across ATS providers (Greenhouse, Lever, Ashby, SmartRecruiters,
Workday). A matching engine (embeddings + LLM reranker) scores how well a
candidate fits each job, and an LLM pipeline tailors a résumé per application.

This mockup is the **operator console** — the internal tool the agency's
recruiters ("operators") use to place candidates into roles at high throughput.

**The core inversion that makes this "AI-first":** the operator does NOT manually
hunt jobs and fill out applications. The system surfaces ranked matches, drafts
tailored résumés, and pre-fills applications. **The operator's job is to review
and approve at speed.** Design every screen around that. The home screen is a
*review queue*, not a data-entry form.

---

## 2. Entity model (the mockup's fake data shape)

```
Organization (the agency tenant)
 └─ Operator        (a recruiter seat; has a "book" of candidates)
     └─ Candidate   (a represented job-seeker)
         └─ Target Track   (a job search, e.g. "Data Engineer · remote · US")
             │                 carries: criteria + a base résumé
             ├─ Match         (a job from the index scored against the track)
             └─ Application    (job × track × tailored résumé; has a lifecycle)
```

Key modeling decisions (keep these — they're deliberate):
- **Target Track, not loose résumés.** A candidate targeting both "Data Engineer"
  and "ML Engineer" has *two tracks*, each with its own criteria, match feed, and
  base résumé. "Two résumés for different jobs" = two tracks.
- **Application is first-class** with a status lifecycle (kanban).
- **Tailored résumé is generated per application**, not uploaded per job.
- **Confidence gating:** each match has a `confidence` (high/medium/low). High-
  confidence matches on a pre-approved track can "autopilot" (auto-tailored,
  queued to send); medium/low surface to the operator. Show this distinction.
- **Guardrails are visible:** never apply a candidate to the same company twice;
  a per-candidate daily application cap; company exclusion lists. Surface these
  as badges/warnings in the UI.

### Fixture fields (use these in the fake data)

```ts
Organization { id, name, plan, seatCount }

Operator {
  id, orgId, name, avatarUrl, email,
  candidateCount, matchesAwaitingReview, applicationsThisWeek, responseRate // %
}

Candidate {
  id, operatorId, name, avatarUrl, headline,   // "Senior Data Engineer, 8 yrs"
  location, consentStatus,                       // "active" | "pending" | "revoked"
  status,                                        // "active" | "paused" | "placed"
  newMatches, activeApplications, responseRate
}

TargetTrack {
  id, candidateId, title,                        // "Data Engineer · Remote · US"
  criteria: { roleFamilies[], locations[], workplace, seniority, minComp },
  baseResumeName,                                // "Priya_DataEng_v3.pdf"
  autopilot: boolean,                            // pre-approved → high-conf auto-flows
  matchCount, newMatchCount
}

Match {
  id, trackId, candidateId,
  jobTitle, company, companyLogoUrl, location, workplace, // "remote"|"hybrid"|"onsite"
  compRange,                                     // "$160k–$190k" or null
  source,                                        // "greenhouse" | "ashby" | ...
  postedAt, jobUrl,
  fitScore,                                      // 0–100 (reranker output)
  confidence,                                    // "high" | "medium" | "low"
  rationale,                                     // 1–2 sentence "why this fits"
  status,                                        // "new" | "approved" | "rejected" | "applied"
  guardrails: []                                 // e.g. ["already applied to company"]
}

Application {
  id, candidateId, candidateName, trackTitle,
  jobTitle, company, companyLogoUrl,
  tailoredResumeName,                            // "Priya_Stripe_DataEng.pdf"
  stage,    // "drafted" | "ready_to_send" | "applied" | "responded" | "interview" | "offer" | "rejected" | "placed"
  fitScore, appliedAt, lastUpdate, source
}
```

Generate **realistic volume**: ~1 org, 1 logged-in operator with **~12–18
candidates**, each candidate **1–2 tracks**, a match inbox of **~40–60 matches**
across the book, and **~30 applications** spread across all kanban stages. Use
believable tech/IT roles and real-sounding companies (Stripe, Databricks,
Ramp, Anthropic, Figma, etc.) and varied fit scores/confidence so the screens
look alive. Job families are tech/IT/knowledge-work only (no service/retail/
clinical roles — that's the product's positioning).

---

## 3. Screens to build

Use a persistent **left sidebar** nav: Match Inbox · Pipeline · Candidates ·
Analytics. Top bar: org name, logged-in operator avatar, a global search box.

### 3.1 Match Inbox  *(home — the daily driver)*
The most important screen. A ranked, scannable review queue of matches across the
operator's whole book.
- **Header strip:** "Today: 52 new matches · 38 high-confidence (autopilot ready) ·
  14 need review." Buttons: *Approve all high-confidence*, filters (candidate,
  confidence, source, workplace).
- **Match rows/cards** (list, dense, keyboard-navigable feel). Each shows:
  candidate avatar+name, job title @ company (logo), location/workplace, comp,
  source badge, **fit score** (prominent, color-coded: green ≥80, amber 60–79,
  grey <60), **confidence** pill, and the one-line **rationale**.
  - Per-row actions: **Approve** (→ queues tailored résumé + application),
    **Reject**, **View** (opens detail drawer), **Tailor preview**.
  - If a guardrail fires, show an inline warning badge ("⚠ already applied to
    Stripe") and disable Approve.
- **Detail drawer** (slides from right when you click View): full JD summary,
  candidate-vs-job fit breakdown (skill overlap chips, matched/missing), the
  tailored-résumé preview (just show a mocked diff/highlights), and approve/reject.
- **Bulk select** with a sticky action bar ("12 selected → Approve / Reject").

### 3.2 Pipeline  *(kanban)*
Application tracker across the whole book (filterable to one candidate).
- Columns = stages: **Drafted → Ready to send → Applied → Responded → Interview →
  Offer → Placed** (plus a Rejected lane).
- Cards: candidate name+avatar, job title @ company, fit score, tailored-résumé
  filename, time-in-stage, source badge. Drag-and-drop between columns (mock the
  state change in local state).
- A "Ready to send" card has a primary **Assisted apply** button (mock: opens a
  modal showing pre-filled fields + the tailored PDF, with a "Mark as applied"
  confirm — we do NOT auto-submit, see §5).

### 3.3 Candidates  *(the book)*
- **Roster list/grid:** each candidate card shows avatar, name, headline,
  consent status badge, status, and three counts: **new matches**, **active
  applications**, **response rate**. Sort/filter by "most matches awaiting review."
- **Candidate detail page** (click a candidate):
  - Header: name, headline, location, consent status, pause/resume control.
  - **Target tracks** section: each track card with its criteria chips, base
    résumé, an **Autopilot** toggle, and match count.
  - **Match feed** for that candidate (a filtered Match Inbox).
  - **Applications** for that candidate (a filtered kanban / list).
  - **Activity / audit trail:** "Applied to Ramp on behalf of candidate · Jun 6"
    — reinforces the consent/transparency story.

### 3.4 Analytics  *(org/operator view)*
- **Placement funnel** (the money metric): Matches → Reviewed → Applied →
  Responded → Interview → Placed, as a funnel chart with conversion %s.
- Cards: applications sent this week, response rate, time-to-first-response,
  active candidates, placements MTD.
- A simple bar/line chart of applications-per-day and a per-operator leaderboard
  (mock multiple operators here even though only one is "logged in").

---

## 4. Look & feel
- Clean, modern SaaS admin aesthetic — think Linear / Vercel dashboard density.
  Lots of data, calm layout, strong typographic hierarchy, subtle borders, not
  cards-with-big-shadows everywhere.
- Light mode primary; dark mode a plus, not required.
- Color: one accent (indigo/violet is fine), semantic colors for fit score and
  stages. Keep it restrained.
- **Density matters** — operators live in the Match Inbox all day. Favor compact
  rows, keyboard-affordance cues, and fast scanning over big marketing-style cards.
- Empty/loading states can be minimal but present.

---

## 5. Hard constraints (do NOT do these)
- **No real backend, auth, or database.** All data is hardcoded fixtures in the
  front end. One "logged-in operator" is fine to hardcode.
- **No live ATS submission.** "Apply" is *assisted*: a modal that shows pre-filled
  fields + the tailored résumé and a manual "Mark as applied" — never auto-submit.
  (Real reason: headless mass-apply violates ATS ToS and gets candidates
  blacklisted. The mockup should model the human-in-the-loop apply.)
- **No actual LLM calls / résumé parsing.** Mock the tailored-résumé preview and
  fit rationale as static fixture text.
- Keep it to the four screens above. Don't build settings/billing/onboarding yet.

---

## 6. Tech & how to deliver
- **Stack:** Next.js (App Router) + Tailwind CSS. (Matches our existing
  `status-page/`.) React 19 / Next 15. Tailwind v4.
- Single app, client components where interactivity is needed. Fixtures in a
  `lib/fixtures.ts` (or `.js`) module imported by the pages.
- It should `npm install && npm run dev` and be fully clickable: nav works,
  approve/reject mutates local state, kanban drag works, drawers open.
- Build it as a standalone app in a new folder (e.g. `operator-console/`) so it
  doesn't collide with the existing `status-page/`.

## 7. Acceptance criteria
1. `npm run dev` serves a working app; all four nav destinations render.
2. Match Inbox: can approve/reject a match and see it leave the queue; the
   high-confidence vs needs-review split is visible; a guardrail warning appears
   on at least one match and blocks its Approve.
3. Pipeline: cards exist in every stage; drag-and-drop moves a card and persists
   in local state for the session; "Ready to send" opens the assisted-apply modal.
4. Candidates: roster renders with the three counts; a candidate detail page shows
   tracks (with Autopilot toggle), match feed, applications, and an audit trail.
5. Analytics: the placement funnel and the summary cards render with fixture data.
6. Data looks realistic and tech/IT-focused; nothing is obviously lorem-ipsum.

---

## 8. Context the builder should respect (product truths)
- Customers/candidates are **tech, IT, knowledge-work, senior/exec, and students
  in those fields** — never service/manual/retail/clinical roles.
- The matching engine already exists conceptually: **embedding retrieval + an LLM
  pointwise reranker** producing a 0–100 fit score and a short rationale. Treat
  `fitScore` + `rationale` as outputs of that engine.
- A **multi-agent CV-tailor** produces the per-application tailored résumé. Treat
  `tailoredResumeName` + the preview as its output.
- This console is the **human-in-the-loop layer** over those automated pipelines.
  Throughput and trust (consent, audit trail, guardrails) are the whole point.
