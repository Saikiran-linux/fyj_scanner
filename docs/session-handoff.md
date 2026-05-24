# docs/session-handoff.md — handoff template

Copy this to the top of `claude-progress.md` at the end of any session whose work spans more than one sitting. Long-running tasks lose continuity (lecture 05) because the *next* session doesn't know what's verified vs. assumed. This template forces you to be explicit.

If a session was self-contained (single bug fix landed + verified in one go), a normal `claude-progress.md` entry is enough — you don't need this.

---

## Template — copy from below

```markdown
## YYYY-MM-DD · <short noun phrase: what this session was about>

**Goal of this session**

<1–2 sentences. What were you trying to accomplish? Why was it worth doing now?>

**What changed**

- Files touched: <list, with one-line per file of what changed>
- Schema changes: <yes/no; if yes, was schema.sql updated and re-runnable?>
- New deps: <yes/no; if yes, root or status-page>
- New env vars / secrets: <list>

**Verified state**

What you can swear is true *as of right now*, with the command/query that proves it:

- [ ] `./init.sh` exits 0
- [ ] `npm run scan` completes locally without error (or: last cron scan green per dashboard query 0c)
- [ ] <feature-specific check, e.g. "match_resume RPC returns 30 rows in <1s">
- [ ] No new console errors in `status-page` (`cd status-page && npm run dev`, click around)

**What's NOT verified** (call this out explicitly — premature victory is the #1 failure mode):

- <e.g. "Embedding backfill is running in background; haven't confirmed final cost.">
- <e.g. "Phase-2 onboarding flow scaffolding compiled but no user-test yet.">

**Known issues introduced or surfaced**

- <bug discovered while doing the work, even if unrelated to the task>
- <thing that worked but feels brittle and you'd want to revisit>

**Next actions (for the next session)**

Ordered, smallest-first. Each item is doable in <30 min so the next session can pick up cleanly.

1. <action>
2. <action>
3. <action>

**Open questions for the human**

- <question that blocked you or that you punted on>

**Pointers**

- Relevant feature_list.json items: <ids, e.g. f-007, f-008>
- Relevant dashboard queries: <numbers from supabase/dashboard-queries.sql>
- Relevant code locations: <file:line>
```

---

## Why each section exists

- **Goal** — forces you to name the why. If you can't, you're padding the log.
- **What changed** — gives the next session a grep-ready list, not "I cleaned up some stuff."
- **Verified state** — separates "I think it works" from "I ran this command and got this output." Lecture 09 (premature victory).
- **What's NOT verified** — without this section, the next session inherits your assumptions as facts.
- **Known issues** — captures the "by the way, while I was in there" observations that otherwise rot.
- **Next actions** — keeps `claude-progress.md` actionable rather than reminiscent.
- **Open questions** — surfaces human-only decisions so they don't block silently.
- **Pointers** — the next session shouldn't have to re-derive context. Give it the breadcrumbs.
