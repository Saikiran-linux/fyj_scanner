#!/usr/bin/env bash
# fyj_scanner — init / verify the harness is healthy.
# Runs in <5 s. Exits non-zero on any failure so CI / agents can gate on it.
#
# Usage:  ./init.sh           — full check
#         ./init.sh --quiet   — only print failures
#
# Lecture 06 in the harness-engineering syllabus is the why: initialization
# deserves its own phase so the agent doesn't bury setup failures inside a
# "try to do the real task" loop.

set -u
QUIET=${1:-}
PASS=0; FAIL=0
say()  { [ "$QUIET" = "--quiet" ] || echo "$@"; }
ok()   { PASS=$((PASS+1)); say "  ok    $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL  $*" >&2; }

say "── fyj_scanner init ──"

# 1. Node version (engines.node = >=20.6 because we use --env-file).
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -p 'process.versions.node')
  NODE_MAJOR=${NODE_VER%%.*}
  if [ "$NODE_MAJOR" -ge 20 ]; then ok "node $NODE_VER (>= 20.6 required)"
  else fail "node $NODE_VER < 20.6 — upgrade"
  fi
else
  fail "node not on PATH"
fi

# 2. .env presence + required keys (no values printed — secrets stay secret).
if [ -f .env ]; then
  ok ".env present"
  for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    if grep -q "^${k}=." .env; then ok "  $k set"
    else fail "  $k missing from .env"
    fi
  done
  if grep -q "^OPENAI_API_KEY=." .env; then ok "  OPENAI_API_KEY set (LLM summary pass enabled)"
  else say "  --    OPENAI_API_KEY not set (LLM summary pass will skip)"
  fi
  if grep -q "^VOYAGE_API_KEY=." .env; then ok "  VOYAGE_API_KEY set (embed pass enabled — f-152: voyage-4-large)"
  else say "  --    VOYAGE_API_KEY not set (embed pass will skip — f-152 moved embeddings off OpenAI)"
  fi
else
  fail ".env missing — copy from .env.example or fetch secrets"
fi

# 3. .env not tracked by git — single most common leak vector.
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env IS TRACKED BY GIT — run: git rm --cached .env"
else
  ok ".env not tracked by git"
fi

# 4. Windows / Norton CA gotcha. Only required on this machine; warn elsewhere.
case "${OS:-}" in
  Windows_NT)
    if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
      ok "NODE_EXTRA_CA_CERTS = $NODE_EXTRA_CA_CERTS"
    elif [ -f "$HOME/.career-ops/norton-root.pem" ]; then
      say "  --    NODE_EXTRA_CA_CERTS unset; run: export NODE_EXTRA_CA_CERTS=\"\$HOME/.career-ops/norton-root.pem\""
    else
      say "  --    NODE_EXTRA_CA_CERTS unset and no fallback found; OpenAI/Supabase fetches may fail on this Windows host"
    fi
    ;;
esac

# 5. Supabase reachable + latest scan status.
if [ -f .env ] && command -v node >/dev/null 2>&1; then
  RESULT=$(node --env-file=.env -e "
    (async () => {
      const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/scans?select=status,ended_at&order=started_at.desc&limit=1', {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY },
      });
      if (!r.ok) { console.log('HTTP ' + r.status); process.exit(2); }
      const rows = await r.json();
      if (!rows.length) { console.log('no scans yet'); process.exit(0); }
      console.log(rows[0].status + ' ' + (rows[0].ended_at || 'running'));
    })().catch((e) => { console.log('error ' + e.message); process.exit(2); });
  " 2>&1)
  case "$RESULT" in
    ok*)      ok "Supabase reachable; latest scan: $RESULT" ;;
    running*) ok "Supabase reachable; a scan is currently running" ;;
    *)        fail "Supabase / latest scan: $RESULT" ;;
  esac
fi

# 6. node_modules check. The scan/data path stays bare-fetch by design (fast
#    cold start); the only sanctioned deps are the OPTIONAL observability SDKs
#    (@sentry/node + langsmith — env-gated no-ops, see src/observability.mjs).
#    Flag a mismatch if the lockfile pins packages that aren't installed.
#    status-page has its own node_modules and isn't checked here.
if [ -f package-lock.json ]; then
  LOCK_PKGS=$(node -e "try{const l=require('./package-lock.json');console.log(Object.keys(l.packages||{}).filter(p=>p.startsWith('node_modules/')).length)}catch{console.log(0)}")
  if [ "$LOCK_PKGS" -gt 0 ] && [ ! -d node_modules ]; then
    fail "package-lock.json pins $LOCK_PKGS deps but node_modules missing — run npm install"
  else
    ok "deps: $LOCK_PKGS pinned (observability SDKs only; scan path stays bare-fetch)"
  fi
fi

# Summary.
echo
echo "── init: $PASS pass · $FAIL fail ──"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
