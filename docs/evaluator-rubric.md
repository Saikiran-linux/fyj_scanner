# docs/evaluator-rubric.md — self-scoring scorecard

Before claiming a task is "done," score yourself against the six dimensions below. Each runs 0–3. **Total ≥ 15/18 + zero zeros = ship.** Anything else means you have a known gap; record it in `claude-progress.md` instead of glossing over it.

The dimensions are derived from the walking-labs harness syllabus (lectures 09 + 10 + 11), but the descriptors below are tailored to *this* repo — generic rubrics let you self-grade yourself into a hole.

---

## 1. Correctness

Does the code do what the task said?

| Score | Looks like |
|---|---|
| 0 | Doesn't compile / SQL errors / RPC returns wrong type. |
| 1 | Compiles + happy path works on one input. Edge cases unexamined. |
| 2 | Works on the happy path + at least two adversarial inputs you actually tried (e.g. empty descriptions, jobs with null embeddings, slug with special chars). |
| 3 | Same as 2 + you can name a class of input it would fail on and have either handled it or written it down as a known limitation. |

## 2. Verification

Can you *prove* it works without re-asking the model?

| Score | Looks like |
|---|---|
| 0 | "It looked right when I ran it." No saved command. |
| 1 | One command you ran in the terminal that you can paste into the progress entry. |
| 2 | Same as 1 + the command is committed (as a script, an `npm run …` entry, or a dashboard query) so the *next* session can re-run it. |
| 3 | Same as 2 + the command runs in `init.sh` or in a `.github/workflows/*.yml` check so regressions are caught automatically. |

## 3. Scope

Did you do what was asked, or did you wander?

| Score | Looks like |
|---|---|
| 0 | Touched files unrelated to the task with no justification. Rewrote things "while you were in there." |
| 1 | Mostly on-scope; a couple of unrelated tweaks slipped in but they're noted. |
| 2 | On-scope. Anything you noticed that's worth changing is captured in `feature_list.json` or a `mcp__ccd_session__spawn_task` call, not silently changed. |
| 3 | Same as 2 + you explicitly *didn't* fix things you could have, because they'd bloat this change. The next-session breadcrumb is clear. |

## 4. Reliability

Will it survive the scanner's real conditions?

| Score | Looks like |
|---|---|
| 0 | Hardcodes assumptions that will break (e.g. "this provider always returns ≤ 1000 jobs", "OpenAI never 429s"). |
| 1 | Handles the common failure (network blip, 429, empty response) but not gracefully. |
| 2 | Failures are logged with enough context to debug. Retries are bounded and back off. Doesn't poison shared state on failure (e.g. doesn't close jobs based on a failed probe). |
| 3 | Same as 2 + the failure path itself was tested at least once (forced a 429, killed a connection, fed a null), not just code-read. |

## 5. Maintainability

How fast will the next session figure this out?

| Score | Looks like |
|---|---|
| 0 | No comments. Names like `data2`, `tmp`, `do_thing`. Magic numbers without source. |
| 1 | Readable code, but a new reader has to derive the *why* from the *what*. |
| 2 | Each non-obvious decision has a one-line comment explaining the trade-off (this codebase's existing style — copy it). Constants pulled to env vars where they actually need to vary. |
| 3 | Same as 2 + you updated `CLAUDE.md`, `feature_list.json`, or `docs/architecture.excalidraw` if the change altered how someone should navigate the repo. |

## 6. Handoff readiness

Can the next session pick this up without asking?

| Score | Looks like |
|---|---|
| 0 | No `claude-progress.md` entry. `clean-state-checklist.md` not run. |
| 1 | Progress entry exists but is one line of "did the thing." |
| 2 | Progress entry covers what changed, verified state, and what's queued next. `feature_list.json` is up to date. |
| 3 | Same as 2 + if the work crossed sessions, `docs/session-handoff.md` was used as the entry template. Open questions for the human are listed explicitly. |

---

## Scoring shortcuts

- **Any 0** = do not say "done." Address it or document it as a known gap.
- **Total 15–18, no zeros** = ship. Tick the clean-state checklist and write the progress entry.
- **Total 10–14** = partial — write the progress entry, mark the relevant `feature_list.json` row `in_progress`, and queue what's left as next actions.
- **Total < 10** = back to the drawing board. Don't ship.

The score lives in the `claude-progress.md` entry, not in a comment. Format:

```
Self-score: 17/18 (correct 3 · verify 3 · scope 3 · reliability 2 · maintain 3 · handoff 3 — reliability docked because I didn't force a 429 against OpenAI).
```

That "because" is the whole point: a confident number with a humble reason is more valuable than an abstract claim.
