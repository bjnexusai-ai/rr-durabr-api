#!/usr/bin/env bash
# PayU pre-deploy checks. Prints PASS/FAIL/WARN only, never key, salt or hash values.
cd "$(dirname "$0")/.." || exit 1
fail=0
ok(){ echo "PASS  $1"; }
bad(){ echo "FAIL  $1"; fail=1; }
warn(){ echo "WARN  $1"; }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
LIVEKEY="OoUP""Lr"

chk ".dev.vars is git-ignored" 'git check-ignore -q .dev.vars'
chk ".dev.vars is not tracked" '! git ls-files --error-unmatch .dev.vars'
chk "live key not in tracked files" '! git grep -q "$LIVEKEY"'
chk "shared test key not in src/" '! grep -rq "gtKFFx" src'
chk "shared test salt not in src/" '! grep -rq "4R38IvwiV57FwVpsgOvTXBdLE4tHUXFW" src'
chk "src/payu.js syntax" 'node --check src/payu.js'
chk "src/payuverify.js syntax" 'node --check src/payuverify.js'
chk "src/ordering.js syntax" 'node --check src/ordering.js'
chk "pending status is not treated as failure" "grep -q \"vr.status === 'pending'\" src/ordering.js"
chk "PAID only after server-side verify success" "grep -q \"sv.status !== 'success'\" src/ordering.js"
chk "test endpoint in src" 'grep -rq "test.payu.in" src'
chk "live endpoint in src" 'grep -rq "secure.payu.in" src'
chk "mock payments not enabled in wrangler.toml" '! grep -Eq "^ALLOW_MOCKS *= *\"?true" wrangler.toml'

if grep -Eq '^PAYU_MODE *= *"live"' wrangler.toml; then ok "PAYU_MODE is live"; else warn "PAYU_MODE is not live in wrangler.toml (fine until go-live)"; fi
if grep -Eq '^ONLINE_ORDER_LIVE *= *"true"' wrangler.toml; then warn "ONLINE_ORDER_LIVE is true: ordering is open"; else ok "ONLINE_ORDER_LIVE is off"; fi
grep -Eq '^API_ORIGIN' wrangler.toml || warn "API_ORIGIN not in wrangler.toml (the PayU callback URL is built from it; confirm it is set)"
[ -z "$(git ls-files | grep -E '\.bak|\.orig')" ] || warn "backup files are tracked: $(git ls-files | grep -E '\.bak|\.orig' | tr '\n' ' ')"

chk "full test suite passes" 'npm test'
chk "working tree clean" '[ -z "$(git status --porcelain)" ]'
chk "branch fully pushed" '[ -z "$(git log @{u}.. --oneline)" ]'

if npx wrangler secret list 2>/dev/null | grep -q PAYU_KEY && npx wrangler secret list 2>/dev/null | grep -q PAYU_SALT; then
  ok "PAYU_KEY and PAYU_SALT set as Worker secrets"
else
  warn "could not confirm PAYU_KEY/PAYU_SALT Worker secrets (not logged in, or not set)"
fi
echo; [ $fail -eq 0 ] && echo "NO FAILURES (read the WARN lines)" || echo "SOME CHECKS FAILED, do not deploy"
exit $fail
