# docs/clean-state-checklist.md — pre-close checklist

Run this **at the end of every session**, before saying "done." Each item is a hard gate. If you can't tick one, either fix it or write the failure explicitly into your `claude-progress.md` entry — never silently leave it broken.

Lecture 12 in the harness-engineering syllabus: every session must leave a clean state, otherwise the next session inherits an unverified mess.

---

## Hard gates (must pass)

- [ ] **`./init.sh` exits 0.** All 9 checks green. If a check is intentionally bypassed (e.g. OPENAI_API_KEY absent on purpose), say so in the progress entry.
- [ ] **No uncommitted `.env` / secrets.** `git status` is clean of any file matching `.env*`, `*.pem`, `*.key`, `*credential*`, `*.token`.
- [ ] **No tracked file contains an actual secret.** Run: `git grep -nE 'sb_secret_|sk-[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]+'`. Should be empty.
- [ ] **Schema changes are idempotent.** If you edited `supabase/schema.sql`, you re-ran it against the live DB and it succeeded with zero errors on existing rows.
- [ ] **Latest scan is `ok` (or you know why it isn't).** `select status, ended_at from public.scans order by started_at desc limit 1` returns `ok`. If `failed` or `running`, note it in the progress entry.
- [ ] **No `.claude/worktrees/*` leftover from your session.** `ls .claude/worktrees/ 2>/dev/null` — any worktree you spawned should be cleaned up.

## Documentation gates

- [ ] **`claude-progress.md` has a new entry at the top** describing this session. One screen max.
- [ ] **`feature_list.json` reflects reality** — anything you finished is flipped to `shipped` with `evidence`; anything new you started has a new entry.
- [ ] **If you changed the architecture, `docs/architecture.excalidraw` is updated.** Don't leave the diagram lying.
- [ ] **If you added a script, it's in `package.json` `scripts` OR documented in `CLAUDE.md`.** Untracked entrypoints rot.

## Verification gates

- [ ] **Anything you claim is "working" has a command/query that proves it.** Paste the command into the progress entry; don't just assert it.
- [ ] **You ran the actual feature end-to-end at least once.** Compilation is not verification (lecture 10).
- [ ] **If you scored your work against `docs/evaluator-rubric.md`, the score is in the progress entry.** Self-scoring forces honesty.

## Common "didn't notice" misses (the cheat sheet)

| Miss | Catch |
|---|---|
| Left an MCP RPC created during exploration but not in `schema.sql` | `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname not in (... schema.sql functions ...)` |
| Backfill running in background, called the task done | List backgrounded processes; if anything still running, wait or note it |
| Touched `.github/workflows/scan.yml` and didn't push | `git log --oneline origin/main..HEAD -- .github/` |
| Added a dep to `status-page/` and didn't `npm install` cleanly | `cd status-page && npm ci --dry-run` |
| Bumped `FINGERPRINT_VERSION` (silently breaks dedup across boundary) | `git diff HEAD -- src/fingerprint.mjs` — flag review |
| Added new env var, didn't add it to `init.sh` checks | grep the new var name in `init.sh` |

---

## When you can't pass

If a gate fails and you can't fix it in the time you have:

1. Write the failure into the `claude-progress.md` entry's **"What's NOT verified"** section.
2. Add a `feature_list.json` entry with `status: blocked` or `in_progress` and the next action.
3. **Don't say "done" in the entry summary.** Say "partial — see blocked gates."

The next session reads `claude-progress.md` first. Surface the gap there, not as a surprise discovered three days later.
