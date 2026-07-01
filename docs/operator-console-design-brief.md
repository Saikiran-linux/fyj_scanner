# Operator Console — Design Brief (for prototyping)

> **Purpose of this file:** a self-contained brief to hand to a design/prototyping tool to
> generate a clickable prototype. It assumes **no prior knowledge** of the codebase. Everything
> needed — product context, screens, components, states, sample data, and visual language — is here.
> Build it as a **high-fidelity, clickable prototype with mock data** (no backend).

---

## 1. What this product is (read first)

An **AI-first staffing firm**. The company places job-seekers ("candidates") into roles, using AI to do
most of the work and **human operators only as reviewers/approvers**. The console in this brief is the
**operator's cockpit** — the single internal tool an operator uses all day.

The daily loop the console must support:

1. Every day, the system **surfaces** a ranked list of jobs for each candidate (AI-matched).
2. An operator **triages** each surfaced job → **Accept** or **Decline** (decline always carries a reason).
3. For accepted jobs, **AI agents fire**: tailor the candidate's resume to the job, (later) find the
   hiring contact, and draft a personalized outreach message.
4. The operator **reviews** the AI output → approve, edit-and-approve, or send back.
5. Approved items are **applied** (operator applies manually for now), then **tracked** to outcome
   (interview / offer / rejected).

Two human checkpoints matter: **Triage** (step 2) and **Review** (step 4). Everything else is automated.
The console's job is to make those two gates fast and to make the rest *observable*.

**Design north star:** an operator should comfortably manage **dozens of candidates** at once. Optimize
for **speed, density, and keyboard control** — this is a power-user internal tool, not a consumer app.
Think Linear / Vercel dashboard / Superhuman, not a marketing site.

---

## 2. The core object: an "Opportunity"

The unit that flows through the whole console is an **Opportunity** = one *candidate × job* pairing.
It moves through these statuses (this drives most of the UI):

```
Surfaced → (triage gate) → Declined ✕
                         → Accepted → Agents Running → Review Ready → (review gate) → Approved
                                                                                    → Applied
                                                                                    → Interviewing
                                                                                    → Offer / Rejected
```

Show status as a **named stage with a small colored dot**, never as a kanban column (see §5).

---

## 3. Personas

- **Operator (primary, 95% of usage).** Triages matches, reviews AI artifacts, applies, tracks outcomes.
  Lives in the keyboard. Wants to clear the queue fast and trust the AI.
- **Manager (secondary).** Glances at analytics: throughput, accept-rates, where AI is weak, SLA.

---

## 4. Information architecture / navigation

A persistent **left sidebar** (collapsible to icons). Top-level destinations:

1. **Today** — the operator's home / start-of-day dashboard.
2. **Triage** — the match queue (gate 1).
3. **Review** — AI artifacts awaiting approval (gate 2).
4. **Pipeline** — every active opportunity and its stage (the tracking view; **not** kanban — see §5).
5. **Candidates** — the candidate roster + individual candidate profiles.
6. **Insights** — analytics for the manager.

Top bar: global search (⌘K command palette), the active operator's avatar, and a **"queue counter"**
showing how many items need a human right now (e.g. `Triage 42 · Review 7`).

Keyboard-first throughout: `j/k` to move between rows, `a` accept, `d` decline, `e` edit, `⌘↵` approve,
`⌘K` command palette, `/` focus search.

---

## 5. The tracking view — NOT kanban (this is the key redesign)

The client explicitly dislikes kanban (draggable columns of cards). Use this instead:

### Primary pattern: **Pipeline Table with an inline stage-stepper**

A dense, sortable **data table** — one row per opportunity. Instead of moving cards between columns, each
row shows a **compact horizontal stepper** that visualizes how far that opportunity has progressed:

```
Candidate        Company / Role              Stage progress                         Fit   Updated   Owner
─────────────────────────────────────────────────────────────────────────────────────────────────────────
Priya Nair       Stripe · Data Engineer      ●──●──●──○──○──○  Review Ready          0.86  2h ago    A. Cole
Marco Diaz       Ramp · Backend Eng          ●──●──○──○──○──○  Agents Running        0.79  10m ago   A. Cole
Lena Park        Figma · Sr. Product Des.    ●──●──●──●──●──○  Applied               0.91  1d ago    J. Wu
```

- The stepper has fixed labeled nodes: **Surfaced · Accepted · Tailored · Reviewed · Applied · Outcome**.
  Filled = done, hollow = pending, the current stage is highlighted. This conveys "where is it" at a
  glance **without** dragging anything.
- Rows are **sortable** (by fit, updated, stage, candidate) and **filterable** via **saved Segments**
  (pill row above the table): `Needs me`, `Awaiting AI`, `Applied this week`, `Stalled > 3 days`,
  `By candidate`, `Interviewing`. Segments replace kanban columns — same grouping power, far denser.
- Bulk-select rows for batch actions.
- **Stalled rows** (no movement past an SLA threshold) get a subtle amber left-border so bottlenecks
  surface without a column.

### Row click → **Detail Drawer with a vertical timeline**

Clicking a row slides in a right-side **drawer** (don't navigate away — keep the list behind it). The
drawer is the opportunity's full story as a **vertical activity timeline**, newest at top:

```
●  Applied by A. Cole — 2h ago
│     via Stripe careers portal · tailored resume v3 attached
●  Resume approved (1 operator edit) — 3h ago
│     edited summary line; rest accepted as-is
●  AI drafted outreach — 4h ago
●  AI tailored resume (Sonnet) — 4h ago   [view diff]
●  Accepted in triage by A. Cole — 5h ago
●  Surfaced · fit 0.86 — today 06:00
      "Strong match: Python + dbt + Airflow; remote OK; comp in band."
```

Below the timeline, tabbed artifacts: **Resume (diff view)**, **Outreach**, **Job description**,
**Candidate snapshot**. Primary action button changes with stage (Approve / Apply / Mark interview…).

> This pattern (sortable table + stepper + timeline drawer) is the explicit **replacement for kanban**.
> When prototyping, do **not** produce draggable card columns anywhere.

---

## 6. Screen-by-screen specs

### 6.1 Today (home)

Start-of-day glance. Top: 3–4 **stat cards** — `Matches to triage (42)`, `Artifacts to review (7)`,
`Applied today (5)`, `Interviews this week (3)`. Each card is a button into the relevant filtered view.

Below: two compact lists —
- **"Needs you now"**: highest-priority items across both gates, mixed (a triage item, a review item),
  each with a one-line reason and an inline action.
- **"Recently moved"**: a short activity feed of what the AI/other operators did overnight.

Empty state when the queue is clear: a calm "You're all caught up" with the day's numbers.

### 6.2 Triage (gate 1) — the match queue

The highest-volume screen. Two-pane layout:

- **Left:** a candidate selector (list of candidates with an unread-match count badge). Default shows an
  "All candidates" merged queue, but operators can focus one candidate.
- **Center/Right:** the **match cards**, one job at a time (focus mode) OR a compact list — offer a toggle.
  For each surfaced job show:
  - Job title, company, location/remote, comp (if known), posted date.
  - **Fit score** (0–1) as a prominent badge + a one-line **"why it matched"** explanation.
  - A **match-evidence** strip: matched skills/keywords as chips (e.g. `Python ✓ dbt ✓ Airflow ✓ AWS ✓`).
  - The candidate snapshot pinned alongside (title, target roles, must-haves) so the operator judges fit
    without context-switching.
  - Two big actions: **Accept** (`a`) and **Decline** (`d`).

**Decline requires a reason** — clicking Decline opens a small reason picker (chips, single click):
`Wrong seniority · Wrong location · Comp too low · Wrong domain · Company blocked · Visa/work-auth ·
Too similar to a declined role · Other (note)`. This reason capture is product-critical — make it
one tap, with an optional note field. After accept/decline, auto-advance to the next card.

Show a slim **progress bar** ("12 of 42 triaged") so the operator feels momentum.

### 6.3 Review (gate 2) — AI artifact approval

List of opportunities in **Review Ready**. Selecting one opens the **review workspace**:

- **Resume diff (primary):** the candidate's base resume vs the AI-tailored version, **side-by-side or
  inline diff**, changes highlighted. Each change shows the AI's **rationale** ("emphasized streaming
  pipeline work to match JD's Kafka requirement"). Sections are **inline-editable**; edits are tracked.
- **Outreach draft:** the personalized message + the resolved hiring contact (name, role, source) shown
  as a card. Editable. (Mark contact-finding as a "coming soon"/stubbed state for now — show a greyed
  "Finding contact…" or "Contact lookup not enabled" placeholder.)
- Actions: **Approve** (`⌘↵`), **Edit & approve**, **Send back** (with a reason → returns to agents).
- A subtle indicator of whether the operator changed anything ("Approved as-is" vs "Approved with 2 edits")
  — this matters because edit-rate is how the firm learns to trust the AI.

### 6.4 Pipeline — see §5 (the non-kanban tracker). This is the tracking screen.

### 6.5 Candidates

- **Roster:** a table of candidates: name, target role, status (Active/Paused/Placed), today's new
  matches, # in pipeline, # applied this week, accept-rate, last activity. Sortable.
- **Candidate detail:** profile (resume, target titles, locations, comp floor, work-auth, blocklist),
  plus that candidate's own pipeline (filtered §5 table) and a **preferences panel** that visibly
  reflects what the system has *learned* from declines ("Auto-hiding: on-site only roles, companies:
  Acme, Globex; prefers: streaming/data-infra"). This closes the loop visibly for the operator.

### 6.6 Insights (manager)

Not kanban, not heavy. A few clean charts:
- **Funnel:** Surfaced → Accepted → Reviewed → Applied → Interview → Offer (conversion at each step).
- **Accept-rate by candidate** (is matching good per person?).
- **Decline-reason distribution** (what is the matcher getting wrong?).
- **AI trust trend:** operator edit-rate on artifacts over time (should fall).
- **Throughput & SLA:** items triaged/reviewed/applied per operator per day; median time-in-stage.

---

## 7. Component inventory (for the design system)

- **Sidebar nav** (collapsible, with queue-count badges).
- **Stat card** (number + label + delta + click-through).
- **Match card** (job + fit badge + evidence chips + accept/decline).
- **Reason picker** (chip grid + optional note).
- **Pipeline table row** with **inline stage-stepper** component (the signature element).
- **Segment pill bar** (saved filters).
- **Detail drawer** (slide-in, with vertical **timeline** component + artifact tabs).
- **Resume diff viewer** (inline + side-by-side toggle, change rationale tooltips).
- **Fit-score badge** (0–1, color-graded: ≥0.85 green, 0.7–0.85 blue, <0.7 grey).
- **Status dot + label** (one consistent mapping of stage→color).
- **Command palette** (⌘K).
- **Empty / loading / error states** for every list.

---

## 8. Visual language

- **Aesthetic:** clean, dense, modern internal-tool. Reference: Linear, Vercel dashboard, Superhuman.
- **Modes:** support **dark and light**; default dark (operators stare at it all day).
- **Type:** a clean sans (Inter / Geist). Tight line-height in tables; generous in the review workspace.
- **Density:** compact tables (32–40px rows), but the two review surfaces (resume diff, outreach) get
  breathing room — that's where careful human reading happens.
- **Color:** restrained neutral base; one accent for primary actions; semantic colors only for
  status/fit (green positive, amber attention/stalled, red declined/rejected, blue in-progress).
- **Motion:** subtle — drawer slide, row auto-advance after triage, optimistic state changes. No bounce.
- **Accessibility:** full keyboard operation, visible focus rings, AA contrast.

---

## 9. Mock data for the prototype

Use ~6 candidates and ~25 opportunities spread across all stages so every screen is populated. Examples:

**Candidates:** Priya Nair (Data Engineer), Marco Diaz (Backend Engineer), Lena Park (Sr. Product
Designer), Sam Okafor (ML Engineer), Aisha Rahman (DevOps/SRE), Tom Beck (Data Analyst).

**Sample opportunities:**

| Candidate | Company · Role | Stage | Fit | Note |
|---|---|---|---|---|
| Priya Nair | Stripe · Data Engineer | Review Ready | 0.86 | resume tailored, outreach drafted |
| Priya Nair | Ramp · Analytics Engineer | Surfaced | 0.81 | awaiting triage |
| Marco Diaz | Vercel · Backend Engineer | Agents Running | 0.79 | tailoring in progress |
| Lena Park | Figma · Sr. Product Designer | Applied | 0.91 | applied 1d ago |
| Lena Park | Linear · Product Designer | Interviewing | 0.88 | recruiter call booked |
| Sam Okafor | Anthropic · ML Engineer | Surfaced | 0.84 | awaiting triage |
| Aisha Rahman | Datadog · SRE | Declined | 0.62 | reason: comp too low |
| Tom Beck | Notion · Data Analyst | Offer | 0.83 | offer received |

Triage queue: ~10 surfaced items with varied fit (0.6–0.92), each with 3–5 evidence chips and a
"why it matched" line. Review queue: 3–4 items with a realistic resume diff (2–4 highlighted changes
with rationales) and an outreach draft.

---

## 10. Prototype scope

**In scope (build clickable):** Today, Triage (accept/decline + reason flow with auto-advance), Review
(diff + approve/edit/send-back), Pipeline table + stepper + detail drawer with timeline, Candidates
roster + detail, Insights (static charts ok). Dark + light. Command palette can be visual-only.

**Out of scope / stub:** real auth, real backend, contact-finding (show as "not enabled" placeholder),
the browser auto-apply agent (operator applies manually → "Mark as applied" button).

**Deliverable:** a navigable prototype where an operator can: land on Today → jump to Triage →
accept a job (watch it move) → see it appear in Review → approve with an edit → mark it applied →
find it in Pipeline at the "Applied" stage with the full timeline in the drawer.
