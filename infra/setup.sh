#!/usr/bin/env bash
#
# infra/setup.sh — recreate the AuthPlane data plane for PR Radar's
# outbound GitHub broker, from an empty database.
#
# infra/config.yaml is the server's tracked *configuration*. Everything
# below is *data* that only ever lived in the SQLite volume: the GitHub
# broker provider, the github broker resource + scope catalogue, the
# pr-radar-live mint resource, the fronting link between them, the
# confidential client carrying the token-exchange grant, and the
# exchange allowlist on the github resource (the difference between
# "only this server may exchange for GitHub tokens" and "any client the
# user has ever consented to" — infra/config.yaml sets dcr.mode: open,
# so that allowlist is the only thing narrowing it back down).
#
# Usage:
#   ./infra/setup.sh
#
# Every credential comes from the environment. If the required
# variables aren't already exported, this sources infra/.secrets.env
# (resolved relative to this script, not $PWD) automatically.
#
# Idempotent: re-running against an already-configured server produces
# no duplicates and no errors. Strategy is check-then-create throughout
# (GET/list first, POST only if absent) rather than "POST and tolerate
# 409" — because only POST /admin/clients documents a 409 on conflict
# (client_exists); broker-providers, resources, fronting links and the
# two policy sub-resource endpoints document no conflict behavior at
# all, and client *names* are provably not unique on this server (three
# separate "Alpic Playground" registrations coexist on the live
# instance). Check-then-create is the one strategy that's safe
# regardless of what an unspecified duplicate POST would do.
#
# The one object with no natural key to check-then-create against is
# the confidential client itself: POST /admin/clients assigns the
# client_id server-side and returns client_secret exactly once. So this
# script persists the minted client_id (and, on first creation only,
# the secret) into infra/.secrets.env as PR_RADAR_SERVER_CLIENT_ID /
# PR_RADAR_SERVER_CLIENT_SECRET, and on every later run checks that
# exact id via GET /admin/clients/{id} (200 = reuse it, anything else =
# mint a new one) instead of matching on the (non-unique) client_name.
#
# Advanced/testing overrides (unset by default):
#   AUTHPLANE_ADMIN_URL     admin API base, default http://localhost:9001
#   AUTHPLANE_SECRETS_FILE  secrets file path, default <this dir>/.secrets.env
#
# Deps: bash, curl, jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="${AUTHPLANE_SECRETS_FILE:-$SCRIPT_DIR/.secrets.env}"

# ---- load secrets ----------------------------------------------------

if [ -z "${AUTHPLANE_ADMIN_API_KEY:-}" ] && [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
fi

# CONNECTOR_GITHUB_SECRET is never sent by this script — the AS
# container reads it directly from its own environment; the request
# body only ever carries the *name* "CONNECTOR_GITHUB_SECRET". It's
# still required here so a forgotten value fails loudly now, not as a
# silent broker-exchange failure later.
REQUIRED_VARS=(
  AUTHPLANE_ADMIN_API_KEY
  AUTHPLANE_APP_URL
  CONNECTOR_GITHUB_CLIENT_ID
  CONNECTOR_GITHUB_SECRET
)

missing=()
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    missing+=("$v")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "setup.sh: missing required variable(s): ${missing[*]}" >&2
  echo "  set them in $SECRETS_FILE, or export them before running this script." >&2
  exit 1
fi

ADMIN_URL="${AUTHPLANE_ADMIN_URL:-http://localhost:9001}"
AUTH="Authorization: Bearer $AUTHPLANE_ADMIN_API_KEY"

# ---- helpers -----------------------------------------------------------

step()    { printf '\n==> %s\n' "$1"; }
created() { printf '  created: %s\n' "$1"; }
exists()  { printf '  exists:  %s (skipped)\n' "$1"; }

# persist_secret NAME VALUE — upsert NAME=VALUE into $SECRETS_FILE,
# preserving 0600 perms (it holds live secrets).
persist_secret() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$SECRETS_FILE" ]; then
    grep -v "^${name}=" "$SECRETS_FILE" > "$tmp" || true
  fi
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

broker_provider_exists() {
  curl -sS -H "$AUTH" "$ADMIN_URL/admin/broker-providers" \
    | jq -e --arg s "$1" 'any(.[]; .slug == $s)' >/dev/null 2>&1
}

resource_exists() {
  curl -sS -H "$AUTH" "$ADMIN_URL/admin/resources" \
    | jq -e --arg s "$1" 'any(.[]; .slug == $s)' >/dev/null 2>&1
}

client_exists() {
  local id="$1" code
  [ -n "$id" ] || return 1
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" "$ADMIN_URL/admin/clients/$id")"
  [ "$code" = "200" ]
}

fronting_exists() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" "$ADMIN_URL/admin/fronting/$1/$2")"
  [ "$code" = "200" ]
}

policy_runtime_has() {
  curl -sS -H "$AUTH" "$ADMIN_URL/admin/resources" \
    | jq -e --arg s "$1" --arg c "$2" \
      '([.[] | select(.slug == $s)][0].policy.runtime.client_ids // []) | index($c) != null' \
      >/dev/null 2>&1
}

policy_exchange_has() {
  curl -sS -H "$AUTH" "$ADMIN_URL/admin/resources" \
    | jq -e --arg s "$1" --arg c "$2" \
      '([.[] | select(.slug == $s)][0].policy.exchange.allowed_client_ids // []) | index($c) != null' \
      >/dev/null 2>&1
}

# ---- 1/6 broker provider: github ---------------------------------------

step "1/6 broker provider: github"
if broker_provider_exists "github"; then
  exists "broker provider 'github'"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/broker-providers" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg cid "$CONNECTOR_GITHUB_CLIENT_ID" '{
      slug: "github",
      display_name: "GitHub",
      protocol: "oauth",
      config_data: {
        client_id: $cid,
        client_secret_env: "CONNECTOR_GITHUB_SECRET",
        authorize_url: "https://github.com/login/oauth/authorize",
        token_url: "https://github.com/login/oauth/access_token"
      }
    }')" >/dev/null
  created "broker provider 'github'"
fi

# ---- 2/6 mint resource: pr-radar-live -----------------------------------

step "2/6 mint resource: pr-radar-live"
if resource_exists "pr-radar-live"; then
  exists "resource 'pr-radar-live'"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/resources" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg uri "$AUTHPLANE_APP_URL/mcp" '{
      slug: "pr-radar-live",
      uri: $uri,
      backend_kind: "mint",
      display_name: "PR Radar",
      scopes: [
        { name: "radar:read",  description: "Read your PR radar" },
        { name: "radar:nudge", description: "Post a nudge comment on a stale PR" }
      ]
    }')" >/dev/null
  created "resource 'pr-radar-live'"
fi

# ---- 3/6 broker resource: github (needs step 1) -------------------------

step "3/6 broker resource: github"
if resource_exists "github"; then
  exists "resource 'github'"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/resources" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{
      "slug": "github",
      "uri": "https://api.github.com",
      "backend_kind": "broker",
      "broker_provider_slug": "github",
      "display_name": "GitHub (broker)",
      "scopes": [
        { "name": "public_repo", "upstream": "public_repo" }
      ]
    }' >/dev/null
  created "resource 'github'"
fi

# ---- 4/6 confidential client: pr-radar-server ---------------------------

step "4/6 confidential client: pr-radar-server"
if client_exists "${PR_RADAR_SERVER_CLIENT_ID:-}"; then
  CLIENT_ID="$PR_RADAR_SERVER_CLIENT_ID"
  exists "client 'pr-radar-server' ($CLIENT_ID)"
else
  resp="$(curl -sS -X POST "$ADMIN_URL/admin/clients" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{
      "client_name": "pr-radar-server",
      "grant_types": ["client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"],
      "token_endpoint_auth_method": "client_secret_basic",
      "scope": "radar:read radar:nudge public_repo"
    }')"
  CLIENT_ID="$(jq -r '.client_id // empty' <<<"$resp")"
  CLIENT_SECRET="$(jq -r '.client_secret // empty' <<<"$resp")"
  if [ -z "$CLIENT_ID" ]; then
    echo "setup.sh: client creation failed, response: $resp" >&2
    exit 1
  fi
  persist_secret PR_RADAR_SERVER_CLIENT_ID "$CLIENT_ID"
  persist_secret PR_RADAR_SERVER_CLIENT_SECRET "$CLIENT_SECRET"
  created "client 'pr-radar-server' ($CLIENT_ID) -- secret saved to $SECRETS_FILE, shown once"
fi

# ---- 5/6 policy bindings (needs steps 2, 3, 4) --------------------------

step "5/6 policy bindings for $CLIENT_ID"
if policy_runtime_has "pr-radar-live" "$CLIENT_ID"; then
  exists "pr-radar-live policy.runtime.client_ids has $CLIENT_ID"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/resources/pr-radar-live/policy/runtime/client-ids" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg cid "$CLIENT_ID" '{client_id: $cid}')" >/dev/null
  created "pr-radar-live policy.runtime.client_ids += $CLIENT_ID"
fi

if policy_exchange_has "github" "$CLIENT_ID"; then
  exists "github policy.exchange.allowed_client_ids has $CLIENT_ID"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/resources/github/policy/exchange/allowed-clients" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$(jq -n --arg cid "$CLIENT_ID" '{client_id: $cid}')" >/dev/null
  created "github policy.exchange.allowed_client_ids += $CLIENT_ID"
fi

# ---- 6/6 fronting link: pr-radar-live -> github (needs steps 2, 3) ------

step "6/6 fronting link: pr-radar-live -> github"
if fronting_exists "pr-radar-live" "github"; then
  exists "fronting link pr-radar-live -> github"
else
  curl -sS -f -X POST "$ADMIN_URL/admin/fronting" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{
      "source": "pr-radar-live",
      "target": "github",
      "scope_map": {
        "radar:read":  ["public_repo"],
        "radar:nudge": ["public_repo"]
      }
    }' >/dev/null
  created "fronting link pr-radar-live -> github"
fi

printf '\nData plane ready.\n'
