# Filtering blue-collar roles out of the staffing lens

> **Status:** findings + plan. Captured 2026-06-12 from live prod. Extends the relevance layer
> ([`../src/classify.mjs`](../src/classify.mjs), feature **f-113**).
> **Question:** for the tech/IT staffing product (Product A), can we reliably filter out
> blue-collar / service / manual / clinical roles?

## Answer: yes — the mechanism already exists, it's a coverage problem

`classify.mjs` already classifies every job by ROLE (not employer industry) into
`{job_family, is_target, seniority}`. Its `NON_TARGET` families **are** the blue-collar exclusion
set: `manual_labor` (warehouse/forklift/driver/picker), `skilled_trades` (electrician/welder/HVAC),
`service_hospitality`, `retail`, `clinical_healthcare`, `security_guard`, `education_childcare`.
So `is_target = false` ≈ blue-collar; the staffing lens filters to `is_target = true`.

## Current coverage (active jobs, 2026-06-12)

| | jobs | % |
|---|---|---|
| `is_target = true` (white-collar/tech) | 35,937 | 34% |
| `is_target = false` (**blue-collar, already filtered**) | 12,063 | 11% |
| `is_target = null` (**unclassified — leaks through**) | 58,264 | **55%** |

Already-caught blue-collar by family: clinical_healthcare 5,170 · skilled_trades 1,753 ·
manual_labor 1,750 · service_hospitality 1,629 · retail 1,558 · security_guard 103 ·
education_childcare 100.

**The gap is the 55% unclassified.** The rules pass is high-precision/low-recall by design; the
LLM backfill that resolves the rest hasn't been run at scale. Blue-collar leaks through the null
bucket — sampled examples the rules missed: *"Food and Beverage Attendant", "Auto Body Repair
Technician", "Licensed Practical Nurse", "Mental Health Therapist", "Spa Therapist", "Distribution
Technician", "Kitchen Assistant", "Railroad Crossing Technician"* — mixed with genuinely
white-collar "associate/assistant" roles and even mislabeled targets ("Mechanical Engineer", "IT
Technician").

## Signals available per ATS (from the raw blob)

| ATS | Usable fields | Quality for blue-collar filtering |
|---|---|---|
| **Title (all)** | `title` | **Primary** — uniform across all 5 ATSes, role-level |
| Greenhouse | `departments[]`, offices[] | Weak — 3,815 distinct free-text values, mostly generic |
| Lever | `categories.{department,team,commitment}` | Weak — free text |
| Ashby | `department`, `team`, `employmentType` | Weak — free text |
| **SmartRecruiters** | **`function`, `industry`, `experienceLevel`** (enums) + department | **Strong** — standardized taxonomy; **currently dropped by the parser** |
| workatastartup | (none; `jobType`) | N/A — YC startups, ~all tech, negligible blue-collar |

Title is the only reliable cross-ATS signal; department is too noisy to trust alone. **SmartRecruiters
uniquely exposes a standardized `function` enum** (verified live: includes *Warehouse, Skilled Labor
& Trades, Restaurant – Food Service, Retail, Transportation, Production, Health Care Provider*) —
the one clean structured blue-collar signal, on the most blue-collar-heavy source, sitting unused in
the R2 blobs. Caveat: SR often sets `function='Other'`, so use it as a positive prior, not a gate.

## Plan (cheap → thorough)

1. **Harden the title rules** (free, immediate). Concrete misses found in the current regex:
   - matches `food & beverage` (ampersand) but not "Food **and** Beverage"
   - no "mental health therapist", "spa therapist", "diversional therapist"
   - `\blpn\b` won't match spelled-out "Licensed Practical Nurse"; add "practical nurse"
   - `manual_labor` missing "distribution technician", "auto body", "reconditioning"
   - add "maintenance technician / maintenance électrique"
   → folded into **f-113** next steps.
2. **Capture SmartRecruiters `function`/`industry`/`experienceLevel`** (parser + columns) and use
   `function` as a strong blue-collar prior for SR. → **f-121**.
3. **Run the LLM classification backfill** (`scripts/backfill-classification.mjs --llm`) on the
   residual ambiguous ~58k — the generic "Associate/Coordinator/Specialist" titles no rule or
   department can resolve. → **f-115 / f-118** (needs `OPENAI_API_KEY` + cost sign-off).

Then the staffing product filters to `is_target = true` and treats `is_target IS NULL`
conservatively (exclude from "verified white-collar" until classified) so blue-collar can't slip
through unclassified. Classification stays by ROLE (a Mechanical Engineer at a factory = target; a
Maintenance Tech at a tech co = not).

> Strategy note (from f-113): do **not** prune blue-collar tenants from the index — Product B (the
> NL jobs MCP) wants the full corpus. Relevance is a per-query *lens* (`target_only`, see f-114),
> not a destructive filter.
