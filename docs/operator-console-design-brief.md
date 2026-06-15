# Operator Console — Design Brief (for prototyping)

> **Purpose of this file:** a self-contained brief to hand to a design/prototyping tool to
> generate a clickable prototype. It assumes **no prior knowledge** of the codebase. Everything
> needed — product context, account hierarchy, screens, components, states, sample data, and visual
> language — is here. Build it as a **high-fidelity, clickable prototype with mock data** (no backend).

---

## 1. What this product is (read first)

An **AI-first staffing firm**. The company places job-seekers into roles, using AI to do most of the
work and **human operators only as reviewers/approvers**. The console in this brief is the **operator's
cockpit** — the single internal tool an operator uses all day.

The daily loop the console must support:

1. Every day, the system **surfaces** a ranked list of jobs for each **campaign** (AI-matched).
2. An operator **triages** each surfaced job → **Accept** or **Decline** (decline always carries a reason).
3. For accepted jobs, **AI agents fire**: tailor the resume to the job, (later) find the hiring contact,
   and draft a personalized outreach message.
4. The operator **reviews** the AI output → approve, edit-and-approve, or send back.
5. Approved items are **applied** (operator applies manually for now), then **tracked** to outcome
   (interview / offer / rejected).

Two human checkpoints matter: **Triage** (step 2) and **Review** (step 4). Everything else is automated.
The console's job is to make those two gates fast and to make the rest *observable*.

**Design north star:** an operator should comfortably manage **dozens of candidates** at once. Optimize
for **speed, density, and keyboard control** — a power-user internal tool, not a consumer app.

---

## 2. Account hierarchy (drives multi-tenancy and scoping)

```
Org  (the staffing firm — a tenant; has billing, settings, branding)
 └── Operator  (a user in the org; an org has many operators)
       └── Candidate  (a job-seeker; an operator manages many candidates)
             └── Campaign  (a targeting/profile; a candidate has one or more)
                   └── Opportunity  (campaign × job — the unit that flows through the pipeline)
```

Read the levels as:

- **Org** — the tenant. Everything is scoped under one org. Has multiple operators, org-wide settings,
  branding, and billing. A manager/admin role sees across all operators in the org; a regular operator
  sees only their assigned candidates by default.
- **Operator** — a logged-in user. **An org has many operators.** Each operator is assigned a set of
  candidates. Work (triage, review, apply) is attributed to an operator.
- **Candidate** — a job-seeker the firm represents. **An operator manages many candidates.** Owns the
  person-level facts: name, contact, base resume, work-auth, overall status (Active/Paused/Placed).
- **Campaign** — *the key new concept.* **A candidate can run multiple campaigns** (think of each as a
  distinct "profile" or job-search track). A campaign has its **own targeting** (target roles, locations,
  comp floor, seniority), its **own tailored base resume variant**, its **own daily match stream**, and
  its **own learned preferences/feedback model**. Example: candidate *Priya* runs a **"Data Engineer"**
  campaign and a separate **"Analytics Engineer"** campaign — different targets, different matches,
  different decline history.
- **Opportunity** — one *campaign × job* pairing. This is what surfaces, gets triaged, gets AI artifacts,
  and is tracked to outcome. **Opportunities belong to a campaign, not directly to a candidate** — so a
  job can be considered independently for two of the same candidate's campaigns.

**Implications for the UI (apply these everywhere):**
- Matching/surfacing, the decline-reason feedback model, and tailored-resume defaults are all **per
  campaign**. The triage stream is grouped **Candidate → Campaign**.
- Breadcrumbs and selectors reflect the tree: `Org / Candidate / Campaign`.
- A **campaign switcher** appears wherever you're inside a candidate.
- Managers get an org-wide scope toggle: **"My candidates" ⟷ "All (org)"** with a per-operator filter.

---

## 3. The core object: an "Opportunity"

The unit that flows through the console = one *campaign × job* pairing. Statuses (drive most of the UI):

```
Surfaced → (triage gate) → Declined ✕
                         → Accepted → Agents Running → Review Ready → (review gate) → Approved
                                                                                    → Applied
                                                                                    → Interviewing
                                                                                    → Offer / Rejected
```

Show status as a **named stage with a small colored dot**, never as a kanban column (see §6).

---

## 4. Personas

- **Operator (primary, ~95% of usage).** Triages matches, reviews AI artifacts, applies, tracks
  outcomes for their assigned candidates' campaigns. Lives in the keyboard.
- **Manager / Org admin (secondary).** Sees across all operators in the org: assigns candidates to
  operators, watches throughput/quality analytics, manages org settings and billing.

---

## 5. Information architecture / navigation

A persistent **left sidebar** (collapsible to icons). Top-level destinations:

1. **Today** — the operator's home / start-of-day dashboard.
2. **Triage** — the match queue (gate 1), grouped Candidate → Campaign.
3. **Review** — AI artifacts awaiting approval (gate 2).
4. **Pipeline** — every active opportunity and its stage (the tracking view; **not** kanban — see §6).
5. **Candidates** — the roster + candidate detail (which contains that candidate's **campaigns**).
6. **Insights** — analytics for the manager.

**Top bar:**
- **Org badge** on the far left (org name + logo; an org switcher only if a user belongs to >1 org).
- **Scope toggle** (managers only): `My candidates ⟷ All (org)` + an operator filter dropdown.
- Global search / command palette (⌘K), the active operator's avatar, and a **queue counter**
  (`Triage 42 · Review 7`).

**Breadcrumbs** under the top bar reflect the hierarchy when you drill in:
`Acme Staffing / Priya Nair / Data Engineer`.

Keyboard-first throughout: `j/k` move between rows, `a` accept, `d` decline, `e` edit, `⌘↵` approve,
`⌘K` palette, `/` search, `[` `]` to switch campaigns within a candidate.

---

## 6. The tracking view — NOT kanban (key pattern)

The client dislikes kanban (draggable columns of cards). Use this instead.

### Primary pattern: **Pipeline Table with an inline stage-stepper**

A dense, sortable **data table** — one row per opportunity. Instead of moving cards between columns, each
row shows a **compact horizontal stepper** that visualizes how far that opportunity has progressed:

```
Candidate · Campaign         Company / Role            Stage progress                     Fit   Updated   Owner
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
Priya N. · Data Engineer     Stripe · Data Engineer    ●──●──●──○──○──○  Review Ready      0.86  2h ago    A. Cole
Marco D. · Backend           Ramp · Backend Eng        ●──●──○──○──○──○  Agents Running    0.79  10m ago   A. Cole
Lena P.  · Sr. Product Des.  Figma · Sr. Product Des.  ●──●──●──●──●──○  Applied           0.91  1d ago    J. Wu
```

- The **Candidate · Campaign** column makes the hierarchy visible at the row level (candidate name +
  campaign label). Filtering by campaign is a first-class action.
- Stepper nodes (fixed, labeled): **Surfaced · Accepted · Tailored · Reviewed · Applied · Outcome**.
  Filled = done, hollow = pending, current stage highlighted. Conveys "where is it" without dragging.
- Rows are **sortable** (fit, updated, stage, candidate) and **filterable** via **saved Segments**
  (pill row above the table): `Needs me`, `Awaiting AI`, `Applied this week`, `Stalled > 3 days`,
  `By candidate`, `By campaign`, `Interviewing`. Segments replace kanban columns — denser, same power.
- Bulk-select for batch actions. **Stalled rows** (past an SLA threshold) get a soft amber left-border
  so bottlenecks surface without a column.

### Row click → **Detail Drawer with a vertical timeline**

Clicking a row slides in a right-side **drawer** (don't navigate away — keep the list behind it). The
drawer header shows the breadcrumb (`Priya Nair / Data Engineer`). Below, the opportunity's full story as
a **vertical activity timeline**, newest at top:

```
●  Applied by A. Cole — 2h ago
│     via Stripe careers portal · tailored resume v3 attached
●  Resume approved (1 operator edit) — 3h ago
●  AI drafted outreach — 4h ago
●  AI tailored resume (Sonnet) — 4h ago   [view diff]
●  Accepted in triage by A. Cole — 5h ago
●  Surfaced · fit 0.86 — today 06:00
      "Strong match: Python + dbt + Airflow; remote OK; comp in band."
```

Below the timeline, tabbed artifacts: **Resume (diff view)**, **Outreach**, **Job description**,
**Campaign snapshot**. Primary action button changes with stage (Approve / Apply / Mark interview…).

> This pattern (sortable table + stepper + timeline drawer) is the explicit **replacement for kanban**.
> Do **not** produce draggable card columns anywhere.

---

## 7. Screen-by-screen specs

### 7.1 Today (home)

Top: 3–4 **stat tiles** — `Matches to triage (42)`, `Artifacts to review (7)`, `Applied today (5)`,
`Interviews this week (3)`. Each tile is a button into the relevant filtered view.

Below, two compact lists:
- **"Needs you now"**: highest-priority items across both gates, each labeled with its
  candidate · campaign, a one-line reason, and an inline action.
- **"Recently moved"**: a short activity feed of what the AI/other operators did overnight.

Empty state when clear: a calm "You're all caught up" with the day's numbers.

### 7.2 Triage (gate 1) — the match queue

Highest-volume screen. Three-level scope on the left:
- **Candidate selector** (operator's assigned candidates, each with an unread-match badge).
- Within a selected candidate, a **campaign tab row** (e.g. `Data Engineer (8) · Analytics Engineer (3)`),
  because matches differ per campaign. A merged "All campaigns" view is the default.

Center/Right: **match cards**, one job at a time (focus mode) or a compact list (toggle). For each
surfaced job show:
- Job title, company, location/remote, comp (if known), posted date.
- **Fit score** (0–1) prominent + a one-line **"why it matched"** explanation.
- **Match-evidence chips** (e.g. `Python ✓ dbt ✓ Airflow ✓ AWS ✓`).
- The **campaign snapshot** pinned alongside (campaign target roles, must-haves) so the operator judges
  fit against *this campaign's* goals without context-switching.
- Two big actions: **Accept** (`a`) and **Decline** (`d`).

**Decline requires a reason** — opens a one-click chip picker: `Wrong seniority · Wrong location ·
Comp too low · Wrong domain · Company blocked · Visa/work-auth · Too similar to a declined role ·
Other (note)`. This feeds the **per-campaign** learning model. After accept/decline, auto-advance.

Slim progress bar ("12 of 42 triaged") for momentum.

### 7.3 Review (gate 2) — AI artifact approval

List of opportunities in **Review Ready** (labeled with candidate · campaign). Selecting one opens the
**review workspace**:
- **Resume diff (primary):** campaign base resume vs the AI-tailored version, **side-by-side or inline**,
  changes highlighted, each with the AI's **rationale**. Sections **inline-editable**; edits tracked.
- **Outreach draft:** personalized message + resolved hiring contact card. Editable. (Contact-finding is
  stubbed for now — show "Finding contact…" / "Contact lookup not enabled".)
- Actions: **Approve** (`⌘↵`), **Edit & approve**, **Send back** (reason → returns to agents).
- Indicator: "Approved as-is" vs "Approved with 2 edits" (edit-rate is how the firm learns to trust AI).

### 7.4 Pipeline — see §6 (the non-kanban tracker).

### 7.5 Candidates

- **Roster:** table of the operator's candidates: name, # campaigns, target roles (summary), status
  (Active/Paused/Placed), today's new matches, # in pipeline, # applied this week, accept-rate, last
  activity. Managers see all operators' candidates with an **Owner** column + operator filter.
- **Candidate detail:** person-level header (resume, work-auth, contact, status) **+ a list of that
  candidate's Campaigns** as the centerpiece. Each campaign card shows: label, target roles/locations/
  comp, today's matches, pipeline count, accept-rate, and a **"+ New campaign"** action.
- **Campaign detail** (drill into a campaign): its targeting (editable), its filtered §6 pipeline table,
  and a **learned-preferences panel** reflecting what declines have taught the system for *this campaign*
  ("Auto-hiding: on-site only; companies: Acme, Globex; prefers: streaming/data-infra").

### 7.6 Insights (manager)

Clean charts, org- or operator-scoped:
- **Funnel:** Surfaced → Accepted → Reviewed → Applied → Interview → Offer (per-step conversion).
- **Accept-rate by campaign** (which campaigns are well-targeted?).
- **Decline-reason distribution** (what is the matcher getting wrong?).
- **AI trust trend:** operator edit-rate on artifacts over time (should fall).
- **Throughput & SLA:** triaged/reviewed/applied per operator per day; median time-in-stage.

---

## 8. Visual language — **Linear × Clay**

The aesthetic is a deliberate blend of two references:

- **Linear** gives the *structure*: dense, fast, keyboard-first, crisp typography, minimal chrome,
  confident dark default, restrained color, sharp information hierarchy. Tables and nav inherit this.
- **Clay (claymorphism)** gives the *surface feel*: soft, tactile, rounded, with gentle depth. Cards,
  tiles, buttons, drawers and chips feel **puffy and pressable** — large corner radii, soft *dual*
  shadows (a light highlight up-top, a soft diffuse shadow below), matte fills, and a warmer, friendlier
  palette than Linear's stark monochrome.

**How to blend without it getting toy-like:** keep Linear's density and discipline for anything
information-dense (the pipeline table, triage list, nav). Apply Clay's softness to *containers and
controls* — stat tiles, match cards, the detail drawer, buttons, segment pills, the fit-score badge.
Result: a pro tool that feels calm and tactile rather than cold.

**Concrete tokens (guidance, tune freely):**
- **Radius:** 14–20px on cards/tiles/buttons; 10–12px on inputs and chips. Generous but not pill-round.
- **Shadows:** soft, layered, low-opacity — e.g. an inner/top light highlight + a diffuse
  `0 8px 24px rgba(0,0,0,.18)`-style bottom shadow. No hard 1px drop shadows.
- **Surfaces:** matte, slightly raised "clay" panels on a soft background; avoid pure `#000`/`#fff`.
- **Palette:** warm, muted base.
  - *Dark (default):* warm charcoal background (e.g. `#16161A`–`#1E1E24`), soft raised panels a step
    lighter, off-white text.
  - *Light:* warm off-white / soft clay-grey (e.g. `#F4F1EE`), white raised panels.
  - **One playful accent** (a soft violet/indigo *or* a warm coral — pick one) for primary actions.
  - **Semantic, slightly desaturated:** green = positive/high-fit, amber = attention/stalled, red =
    declined/rejected, blue = in-progress. Keep them muted to fit the clay warmth.
- **Type:** Inter / Geist. Tight line-height in tables; roomier in the review workspace.
- **Density:** compact tables (32–40px rows); the two review surfaces (resume diff, outreach) breathe.
- **Buttons:** clay-soft, tactile, with a subtle pressed state (shadow inset on click).
- **Motion:** subtle — drawer slide, row auto-advance after triage, optimistic state changes, a gentle
  press on clay buttons. No bounce, no skeuomorphic excess.
- **Modes:** support dark + light; **default dark**.
- **Accessibility:** full keyboard operation, visible focus rings, AA contrast (watch the muted palette).

---

## 9. Mock data for the prototype

One **org**: **"Acme Staffing"**. Two operators: **A. Cole** (logged-in) and **J. Wu**. Cole manages
~5 candidates; show J. Wu's candidates only under the manager "All (org)" scope. Populate every screen.

**Candidates → Campaigns:**

| Candidate | Owner | Campaigns |
|---|---|---|
| Priya Nair | A. Cole | **Data Engineer**, **Analytics Engineer** |
| Marco Diaz | A. Cole | **Backend Engineer** |
| Lena Park | J. Wu | **Sr. Product Designer**, **Product Designer (startup)** |
| Sam Okafor | A. Cole | **ML Engineer** |
| Aisha Rahman | A. Cole | **DevOps / SRE** |
| Tom Beck | A. Cole | **Data Analyst** |

**Sample opportunities (campaign × job):**

| Candidate · Campaign | Company · Role | Stage | Fit | Note |
|---|---|---|---|---|
| Priya · Data Engineer | Stripe · Data Engineer | Review Ready | 0.86 | resume tailored, outreach drafted |
| Priya · Analytics Engineer | Ramp · Analytics Engineer | Surfaced | 0.81 | awaiting triage |
| Marco · Backend Engineer | Vercel · Backend Engineer | Agents Running | 0.79 | tailoring in progress |
| Lena · Sr. Product Designer | Figma · Sr. Product Designer | Applied | 0.91 | applied 1d ago |
| Lena · Product Designer (startup) | Linear · Product Designer | Interviewing | 0.88 | recruiter call booked |
| Sam · ML Engineer | Anthropic · ML Engineer | Surfaced | 0.84 | awaiting triage |
| Aisha · DevOps / SRE | Datadog · SRE | Declined | 0.62 | reason: comp too low |
| Tom · Data Analyst | Notion · Data Analyst | Offer | 0.83 | offer received |

Triage queue: ~10 surfaced items across a couple of campaigns, fit 0.6–0.92, each with 3–5 evidence
chips + a "why it matched" line. Review queue: 3–4 items with a realistic resume diff (2–4 highlighted
changes + rationales) and an outreach draft.

---

## 10. Prototype scope

**In scope (clickable):** Org/operator scoping (top-bar org badge + manager scope toggle), Today,
Triage (candidate→campaign scope, accept/decline + reason flow with auto-advance), Review (diff +
approve/edit/send-back), Pipeline table + stepper + detail-drawer timeline, Candidates roster →
candidate detail (with campaigns) → campaign detail, Insights (static charts ok). Dark + light.
Command palette can be visual-only.

**Out of scope / stub:** real auth, real backend, contact-finding (show "not enabled" placeholder), the
browser auto-apply agent (operator applies manually → "Mark as applied" button).

**Deliverable:** a navigable prototype where an operator can: land on Today → open Triage → pick a
candidate → switch between that candidate's campaigns → accept a job (watch it move) → see it in Review →
approve with an edit → mark it applied → find it in Pipeline at the "Applied" stage with the full
timeline in the drawer. Visuals follow the **Linear × Clay** language in §8.
