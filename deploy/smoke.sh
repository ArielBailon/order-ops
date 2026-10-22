#!/usr/bin/env bash
# Proves a release from outside: /health, a login and one real chat request (costs one short
# model call). Reads SMOKE_EMAIL and SMOKE_PASSWORD from the environment; never prints them or
# the token. Usage: deploy/smoke.sh https://api.arielbailon.dev
set -euo pipefail

base="${1:?usage: smoke.sh <base-url>}"
base="${base%/}"
: "${SMOKE_EMAIL:?set SMOKE_EMAIL}"
: "${SMOKE_PASSWORD:?set SMOKE_PASSWORD}"

fail() { echo "smoke failed: $1" >&2; exit 1; }

# Caddy and the gateway may still be warming up right after a deploy.
ok=0
for _ in $(seq 1 12); do
  if curl -fsS --max-time 5 "$base/health" 2>/dev/null | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 5
done
[ "$ok" -eq 1 ] || fail "health"

# Node builds and reads the JSON (no jq needed); the credentials travel through the environment.
login="$(node -e 'process.stdout.write(JSON.stringify({email:process.env.SMOKE_EMAIL,password:process.env.SMOKE_PASSWORD}))' \
  | curl -fsS --max-time 15 -H 'content-type: application/json' -d @- "$base/auth/login")" \
  || fail "login"
token="$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).accessToken||"")}catch{}' "$login")"
[ -n "$token" ] || fail "login"

# The reply streams SSE; the stream must close with a `final` event.
chat="$(printf '%s' '{"message":"Hi, what can you help me with?"}' \
  | curl -fsS --no-buffer --max-time 90 -H 'content-type: application/json' \
      -H "authorization: Bearer $token" -d @- "$base/chat")" \
  || fail "chat"
grep -q '^event: final' <<<"$chat" || fail "chat (no final event)"

echo "smoke ok: health, login, chat"
