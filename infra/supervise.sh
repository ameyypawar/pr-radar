#!/usr/bin/env bash
#
# supervise.sh — health supervisor for the pr-radar dev stack.
#
# Replaces infra/tunnel-watchdog.sh-style process-liveness checks, which could
# not see the failures that actually happen here. Everything below is probed,
# never inferred from `pgrep`.
#
# The stack, and how each layer actually fails:
#
#   cloudflared   fronts the AuthPlane OAuth server. Can stay alive with zero
#                 live edge connections ("up but wedged"). Probed via its own
#                 metrics /ready endpoint, which reports readyConnections.
#                 ALARM ONLY — after migration it runs under launchd, which
#                 restarts it on crash. We must not fight another supervisor.
#
#   AuthPlane     the OAuth issuer, read fresh from app/.env every iteration so
#                 a re-point (quick tunnel -> named tunnel) is picked up with no
#                 supervisor restart. ALARM ONLY — re-pointing is a human call.
#
#   skybridge dev its supervisor process only respawns the server child on FILE
#                 CHANGE, never on crash. The parent and the tsc --watch child
#                 stay alive while nothing listens on :3000, so process checks
#                 report "running" during a total outage. Probed by port.
#                 It also hard-crashes at boot when the issuer is unreachable
#                 (eager OAuth discovery), so it is never restarted while the
#                 issuer is down — that would crash-loop.
#                 Restarting without killing the old tree leaves a zombie: the
#                 new child hits EADDRINUSE, dies silently, and the OLD code
#                 keeps serving. Every restart kills the whole tree and proves
#                 :3000 is free before starting.
#
#   alpic tunnel  publishes :3000 at a stable public host, so a restart is a
#                 real fix. Blamed only once :3000 is proven healthy locally.
#
#   metadata      skybridge bakes discovered OAuth metadata into its routes at
#                 boot. After an issuer change the server keeps returning a
#                 cheerful 401 while advertising a DEAD issuer — every surface
#                 looks healthy and all auth fails. Compares the live
#                 protected-resource document against app/.env. ALARM ONLY;
#                 the fix is a dev-server restart, which is a human call
#                 because it is indistinguishable from a healthy server.
#
# Checks run in dependency order and later checks are SKIPPED, not guessed at,
# when an earlier one fails. Every mutating step verifies its own result: a
# restart that does not restore health is logged as a FAILURE, never as a
# restart.
#
# Usage:
#   infra/supervise.sh                 # run the loop (foreground)
#   infra/supervise.sh --once          # one iteration, then exit
#   infra/supervise.sh --dry-run       # probe and alarm only; never mutate
#   infra/supervise.sh --interval 20   # seconds between iterations
#   infra/supervise.sh --stop          # stop a running supervisor
#   infra/supervise.sh --status        # is one running?
#
# No secrets are read from or written to this script. app/.env is parsed for
# the single key AUTHPLANE_ISSUER (a public URL) and is never sourced, so the
# tokens and client secrets alongside it never enter this process or the logs.

set -euo pipefail

# ---------------------------------------------------------------- locations --
# Everything derives from the script's own path; nothing is machine-specific.
SCRIPT_PATH=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")
INFRA_DIR=$(dirname -- "$SCRIPT_PATH")
REPO_ROOT=$(cd -- "$INFRA_DIR/.." && pwd -P)
APP_DIR="$REPO_ROOT/app"
ENV_FILE="$APP_DIR/.env"

RUN_DIR="$INFRA_DIR/logs"          # gitignored; see .gitignore
LOG_FILE="$RUN_DIR/supervise.log"
DEV_LOG="$RUN_DIR/devserver.log"
TUNNEL_LOG="$RUN_DIR/alpic-tunnel.log"
PID_FILE="$RUN_DIR/supervise.pid"

# ------------------------------------------------------------------- config --
DEV_PORT=3000
# Public app host. Stable by design, so restarting the tunnel is a real fix.
# Not a secret (it is the advertised MCP endpoint). Overridable so a re-point
# does not require editing a tracked file.
DEFAULT_APP_URL="https://cyan-schools-roll-396.alpic.dev"
URLS_FILE="$INFRA_DIR/urls.env"

# cloudflared binds its metrics server to the FIRST FREE port in this range.
# Under `cloudflared service install` we do not control --metrics, so the port
# cannot be pinned: probe the range and accept the first responder.
CF_METRICS_PORTS="20241 20242 20243 20244 20245"

INTERVAL=15                  # seconds between iterations
PORT_FREE_ATTEMPTS=15        # x1s  — wait for :3000 to be released after a kill
DEV_RECOVER_ATTEMPTS=20      # x2s  — wait for the dev server to serve again
TUNNEL_RECOVER_ATTEMPTS=15   # x2s  — wait for the public host to serve again
MAX_CONSEC_RESTART_FAILS=3   # then stop restarting and alarm only
CONFIRM_ATTEMPTS=3           # a probe must fail this many times before we act
CONFIRM_GAP=3                # seconds between confirmation probes

CURL_CONNECT_TIMEOUT=5
CURL_MAX_TIME=15

ONCE=0
DRY_RUN=0

# --------------------------------------------------------------- log helpers --
# Levels: OK / WARN / ALARM / ACTION / FAIL. Every line names the exact thing
# probed — the old watchdog logged "/try=$code" while probing /mcp, and that
# mislabeling actively misled during an incident.
log() {
    local level="$1"; shift
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') [$level] $*"
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
    # Console copy goes to STDERR on purpose: probe helpers log while their
    # stdout is being captured by command substitution, and a log line landing
    # in a captured value would corrupt the comparison it feeds.
    printf '%s\n' "$line" >&2
}
log_ok()     { log OK     "$@"; }
log_warn()   { log WARN   "$@"; }
log_alarm()  { log ALARM  "$@"; }
log_action() { log ACTION "$@"; }
log_fail()   { log FAIL   "$@"; }

# ------------------------------------------------------------ small utilities --

# Strip CR, surrounding quotes, surrounding whitespace and trailing slashes, so
# that ".../" and "..." compare equal and a CRLF .env does not cause a false
# stale-metadata alarm.
norm_url() {
    local u="${1:-}"
    u="${u%$'\r'}"
    u="${u#"${u%%[![:space:]]*}"}"
    u="${u%"${u##*[![:space:]]}"}"
    case "$u" in
        \"*\") u="${u#\"}"; u="${u%\"}" ;;
        \'*\') u="${u#\'}"; u="${u%\'}" ;;
    esac
    while [ "${u%/}" != "$u" ]; do u="${u%/}"; done
    printf '%s' "$u"
}

# HTTP status only. Prints 000 on any transport failure instead of dying, so a
# transient curl error can never take the supervisor down.
http_code() {
    local url="$1" method="${2:-GET}" code
    if [ "$method" = "POST" ]; then
        code=$(curl -s -o /dev/null -w '%{http_code}' \
            --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
            -X POST "$url" -H 'content-type: application/json' -d '{}' 2>/dev/null) || code=""
    else
        code=$(curl -s -o /dev/null -w '%{http_code}' \
            --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
            "$url" 2>/dev/null) || code=""
    fi
    printf '%s' "${code:-000}"
}

# Body of a GET, or empty on failure. Status is appended as the final line by
# the caller's -w when it needs both.
http_body() {
    local url="$1" out
    out=$(curl -s --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
        "$url" 2>/dev/null) || out=""
    printf '%s' "$out"
}

# Pull a JSON string field's first array element / scalar without depending on
# jq being installed. Whitespace is stripped first; the values here are URLs
# and integers, which never contain spaces.
json_first_auth_server() {
    local body="$1"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$body" | jq -r '.authorization_servers[0] // empty' 2>/dev/null && return 0
    fi
    # Whitespace is stripped first so the shape is exactly ...:["URL"...  .
    # Do NOT put a [^]]* between the '[' and the '"': greedy backtracking then
    # anchors on the CLOSING quote and captures "]," instead of the URL, which
    # would fire a false STALE alarm on any machine without jq.
    printf '%s' "$body" | tr -d ' \n\r\t' \
        | sed -n 's/.*"authorization_servers":\["\([^"]*\)".*/\1/p'
}

json_ready_connections() {
    local body="$1"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$body" | jq -r '.readyConnections // empty' 2>/dev/null && return 0
    fi
    printf '%s' "$body" | tr -d ' \n\r\t' \
        | sed -n 's/.*"readyConnections":\([0-9][0-9]*\).*/\1/p'
}

# Read AUTHPLANE_ISSUER from app/.env WITHOUT sourcing the file — it also holds
# GITHUB_TOKEN and AUTHPLANE_CLIENT_SECRET, which must never enter this
# process's environment or its logs. Last assignment wins, matching dotenv.
read_issuer() {
    local line
    [ -r "$ENV_FILE" ] || return 1
    line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?AUTHPLANE_ISSUER[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -n 1) || line=""
    [ -n "$line" ] || return 1
    norm_url "${line#*=}"
}

read_app_url() {
    local line
    if [ -n "${PR_RADAR_APP_URL:-}" ]; then
        norm_url "$PR_RADAR_APP_URL"; return 0
    fi
    if [ -r "$URLS_FILE" ]; then
        line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?APP_URL[[:space:]]*=' "$URLS_FILE" 2>/dev/null | tail -n 1) || line=""
        if [ -n "$line" ]; then norm_url "${line#*=}"; return 0; fi
    fi
    norm_url "$DEFAULT_APP_URL"
}

# Confirm an unhealthy verdict before acting on it. The remediation for both
# the dev server and the tunnel is destructive (kill the tree, restart), so a
# false negative is expensive: it takes down a working service. A single
# success at any point proves the service is alive, so any success wins.
#
# This is not hypothetical — during verification a POST through the alpic
# tunnel timed out once at 15s while the very next probe returned 401 in 0.8s.
# A one-shot check would have killed a healthy tunnel.
#
# Args: <label> <expected-code> <probe-command...>
# Prints the last observed code; returns 0 if any attempt matched.
confirm_probe() {
    local label="$1" expected="$2"; shift 2
    local i code=""
    for i in $(seq 1 "$CONFIRM_ATTEMPTS"); do
        code=$("$@")
        if [ "$code" = "$expected" ]; then
            [ "$i" -gt 1 ] && log_warn "$label: probe $i/$CONFIRM_ATTEMPTS returned $expected after an earlier miss — transient, treating as healthy"
            printf '%s' "$code"
            return 0
        fi
        if [ "$i" -lt "$CONFIRM_ATTEMPTS" ]; then
            log_warn "$label: probe $i/$CONFIRM_ATTEMPTS returned $code (expected $expected) — reprobing in ${CONFIRM_GAP}s before acting"
            sleep "$CONFIRM_GAP"
        fi
    done
    printf '%s' "$code"
    return 1
}

# ------------------------------------------------------------ process control --

port_listener_pids() {
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

port_is_free() {
    [ -z "$(port_listener_pids "$1")" ]
}

collect_descendants() {
    local parent="$1" child
    for child in $(pgrep -P "$parent" 2>/dev/null || true); do
        printf '%s\n' "$child"
        collect_descendants "$child"
    done
}

# Everything matching a pattern, plus every descendant. `skybridge dev`'s server
# child does NOT carry "skybridge" in its own command line, so matching the
# pattern alone would leave the process that actually holds :3000 alive — which
# is precisely how the EADDRINUSE zombies were created.
tree_pids_for_pattern() {
    local pat="$1" p
    for p in $(pgrep -f "$pat" 2>/dev/null || true); do
        [ "$p" = "$$" ] && continue
        [ "$p" = "1" ] && continue
        printf '%s\n' "$p"
        collect_descendants "$p"
    done
}

# TERM, wait, then KILL survivors. Never signals this script or PID 1.
terminate_pids() {
    local label="$1"; shift
    local pids="$*" p alive i
    [ -n "${pids// /}" ] || { log_warn "$label: no matching processes to kill"; return 0; }

    log_action "$label: sending TERM to pids:$(printf ' %s' $pids)"
    for p in $pids; do
        [ "$p" = "$$" ] && continue
        [ "$p" = "1" ] && continue
        kill -TERM "$p" 2>/dev/null || true
    done

    for i in 1 2 3 4 5 6 7 8; do
        alive=""
        for p in $pids; do
            kill -0 "$p" 2>/dev/null && alive="$alive $p"
        done
        [ -z "${alive// /}" ] && { log_ok "$label: all processes exited after TERM"; return 0; }
        sleep 1
    done

    log_warn "$label: survivors after TERM, sending KILL to pids:$alive"
    for p in $alive; do
        [ "$p" = "$$" ] && continue
        [ "$p" = "1" ] && continue
        kill -KILL "$p" 2>/dev/null || true
    done
    sleep 2

    alive=""
    for p in $pids; do
        kill -0 "$p" 2>/dev/null && alive="$alive $p"
    done
    if [ -n "${alive// /}" ]; then
        log_fail "$label: pids still alive after KILL:$alive"
        return 1
    fi
    log_ok "$label: all processes exited after KILL"
    return 0
}

# nvm is a shell function, so it has to be sourced. Node 20 breaks the skybridge
# toolchain, so a failure to select 24 is a loud, fatal-for-this-action error
# rather than a silent fall-through to whatever node is on PATH.
NVM_READY=0
load_nvm() {
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$nvm_dir/nvm.sh" ]; then
        log_fail "nvm: $nvm_dir/nvm.sh not found — cannot select node 24; dev server and tunnel restarts will not be attempted"
        NVM_READY=0
        return 1
    fi
    set +u
    # shellcheck disable=SC1090,SC1091
    . "$nvm_dir/nvm.sh" >/dev/null 2>&1 || true
    nvm use 24 >/dev/null 2>&1 || true
    set -u
    local v
    v=$(node -v 2>/dev/null) || v=""
    case "$v" in
        v24.*) log_ok "nvm: node $v selected"; NVM_READY=1; return 0 ;;
        *)     log_fail "nvm: 'nvm use 24' did not yield node v24 (got '${v:-none}') — dev server and tunnel restarts will not be attempted"
               NVM_READY=0; return 1 ;;
    esac
}

# Launch under node 24 from $APP_DIR, detached, output to its own log. The cd
# happens inside the child subshell: a failure there can never take the
# supervisor down (the old watchdog's `cd ... || exit 1` killed it silently).
spawn_detached() {
    local logfile="$1"; shift
    nohup bash -c '
        set -u
        cd "$1" || exit 90
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        [ -s "$NVM_DIR/nvm.sh" ] || exit 91
        . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || exit 92
        nvm use 24 >/dev/null 2>&1 || exit 93
        case "$(node -v 2>/dev/null)" in v24.*) ;; *) exit 94 ;; esac
        shift
        exec "$@"
    ' _ "$APP_DIR" "$@" >>"$logfile" 2>&1 &
    printf '%s' "$!"
}

# ------------------------------------------------------------ single instance --
SCRIPT_BASENAME=$(basename -- "$SCRIPT_PATH")
LOCK_HELD=0

pidfile_owner() {
    local existing
    existing=$(cat "$PID_FILE" 2>/dev/null) || existing=""
    case "$existing" in
        ''|*[!0-9]*) return 1 ;;
    esac
    kill -0 "$existing" 2>/dev/null || return 1
    # Guard against a recycled PID belonging to some unrelated process.
    ps -o command= -p "$existing" 2>/dev/null | grep -q -- "$SCRIPT_BASENAME" || return 1
    printf '%s' "$existing"
}

acquire_lock() {
    local owner
    if ( set -o noclobber; printf '%s\n' "$$" >"$PID_FILE" ) 2>/dev/null; then
        LOCK_HELD=1; return 0
    fi
    if owner=$(pidfile_owner); then
        printf 'supervise.sh: another instance is already running (pid %s).\n' "$owner" >&2
        printf 'Stop it with: %s --stop\n' "$SCRIPT_PATH" >&2
        return 1
    fi
    printf 'supervise.sh: removing stale pidfile %s\n' "$PID_FILE" >&2
    rm -f "$PID_FILE"
    if ( set -o noclobber; printf '%s\n' "$$" >"$PID_FILE" ) 2>/dev/null; then
        LOCK_HELD=1; return 0
    fi
    printf 'supervise.sh: could not acquire %s\n' "$PID_FILE" >&2
    return 1
}

release_lock() {
    [ "$LOCK_HELD" = "1" ] || return 0
    local existing
    existing=$(cat "$PID_FILE" 2>/dev/null) || existing=""
    [ "$existing" = "$$" ] && rm -f "$PID_FILE"
    LOCK_HELD=0
}

on_exit() { release_lock; }

# Bash defers trap handlers until the current foreground command finishes, so a
# plain `sleep $INTERVAL` swallows SIGTERM for up to a full interval and --stop
# appears to do nothing. Backgrounding the sleep and `wait`ing on it makes the
# handler fire immediately.
SLEEP_PID=""
interruptible_sleep() {
    sleep "$1" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
    SLEEP_PID=""
}

on_signal() {
    log_warn "supervisor stopping on signal"
    [ -n "$SLEEP_PID" ] && kill -TERM "$SLEEP_PID" 2>/dev/null
    release_lock
    exit 0
}

# ====================================================================== checks =

CF_VERDICT="unknown"   # carried into the issuer alarm as diagnostic context

# cloudflared — ALARM ONLY. Under launchd it restarts itself; a second
# supervisor would fight it. "Up but zero ready connections" is the wedged
# state the old watchdog was structurally blind to, and counts as unhealthy.
check_cloudflared() {
    local port body rc responder=""
    for port in $CF_METRICS_PORTS; do
        body=$(curl -s --connect-timeout 2 --max-time 4 "http://localhost:$port/ready" 2>/dev/null) || body=""
        if [ -n "$body" ]; then responder="$port"; break; fi
    done

    if [ -z "$responder" ]; then
        CF_VERDICT="no metrics responder on localhost:${CF_METRICS_PORTS// /,}"
        log_alarm "cloudflared: DOWN — $CF_VERDICT. Externally supervised (launchd); NOT restarting from here."
        return 1
    fi

    rc=$(json_ready_connections "$body")
    case "$rc" in
        ''|*[!0-9]*)
            CF_VERDICT="metrics on :$responder returned unparseable /ready body"
            log_alarm "cloudflared: UNKNOWN — $CF_VERDICT. Alarm only; NOT restarting from here."
            return 1 ;;
    esac

    if [ "$rc" -lt 1 ]; then
        CF_VERDICT="readyConnections=$rc on localhost:$responder/ready"
        log_alarm "cloudflared: WEDGED — daemon alive but $CF_VERDICT (no live edge connection). Externally supervised (launchd); NOT restarting from here."
        return 1
    fi

    CF_VERDICT="readyConnections=$rc on localhost:$responder/ready"
    log_ok "cloudflared: healthy — $CF_VERDICT"
    return 0
}

# AuthPlane issuer — ALARM ONLY, and it GATES everything below it. The dev
# server does eager OAuth discovery at boot and throws when the issuer is
# unreachable, so restarting it now would only crash-loop.
check_issuer() {
    local issuer="$1" code url
    url="$issuer/.well-known/oauth-authorization-server"
    code=$(http_code "$url" GET)
    if [ "$code" = "200" ]; then
        log_ok "issuer: reachable — GET $url -> $code"
        return 0
    fi
    log_alarm "issuer: UNREACHABLE — GET $url -> $code (cloudflared: $CF_VERDICT)"
    log_alarm "issuer: NOT restarting anything this iteration — the dev server crashes at boot when OAuth discovery fails. Re-pointing AUTHPLANE_ISSUER in app/.env is a human decision."
    return 1
}

# Dev server — probed by PORT, never by process. `pgrep -f 'skybridge dev'`
# reports "running" throughout a total outage because the parent and the
# tsc --watch child survive a server-child crash.
probe_devserver() {
    http_code "http://localhost:$DEV_PORT/mcp" POST
}

restart_devserver() {
    local i code pids

    if [ "$DRY_RUN" = "1" ]; then
        log_warn "devserver: --dry-run set; would have killed the skybridge tree and restarted. No action taken."
        return 1
    fi
    if [ "$NVM_READY" != "1" ]; then
        log_fail "devserver: refusing to restart — node 24 is not selectable (see nvm error above). Starting under the wrong node breaks the toolchain."
        return 1
    fi

    # Kill the pattern matches, their descendants, AND whatever actually holds
    # the port. Missing the port holder is how a zombie ends up serving stale
    # code behind a new supervisor that silently died on EADDRINUSE.
    pids=$( { tree_pids_for_pattern 'skybridge dev'; port_listener_pids "$DEV_PORT"; } | sort -un | tr '\n' ' ')
    log_action "devserver: killing skybridge tree + :$DEV_PORT listeners"
    terminate_pids "devserver" $pids || true

    for i in $(seq 1 "$PORT_FREE_ATTEMPTS"); do
        if port_is_free "$DEV_PORT"; then break; fi
        sleep 1
    done
    if ! port_is_free "$DEV_PORT"; then
        log_fail "devserver: :$DEV_PORT still held after ${PORT_FREE_ATTEMPTS}s by pids:$(port_listener_pids "$DEV_PORT" | tr '\n' ' ')— NOT starting a new one (it would die on EADDRINUSE and leave the old code serving)"
        return 1
    fi
    log_ok "devserver: :$DEV_PORT confirmed free"

    log_action "devserver: starting './node_modules/.bin/skybridge dev --plain' in $APP_DIR under node 24 (log: $DEV_LOG)"
    spawn_detached "$DEV_LOG" ./node_modules/.bin/skybridge dev --plain >/dev/null

    # A restart is only a restart if it restores service. Poll until proven.
    for i in $(seq 1 "$DEV_RECOVER_ATTEMPTS"); do
        sleep 2
        code=$(probe_devserver)
        if [ "$code" = "401" ]; then
            log_ok "devserver: RECOVERED — POST http://localhost:$DEV_PORT/mcp -> 401 after ${i} probe(s)"
            return 0
        fi
    done

    code=$(probe_devserver)
    log_fail "devserver: RESTART FAILED — POST http://localhost:$DEV_PORT/mcp -> $code after $((DEV_RECOVER_ATTEMPTS * 2))s. Service is DOWN. Check $DEV_LOG."
    return 1
}

DEV_FAILS=0
check_devserver() {
    local code
    if code=$(confirm_probe "devserver" 401 probe_devserver); then
        [ "$DEV_FAILS" -gt 0 ] && log_ok "devserver: recovered; clearing failure count ($DEV_FAILS)"
        DEV_FAILS=0
        log_ok "devserver: serving — POST http://localhost:$DEV_PORT/mcp -> 401"
        return 0
    fi

    log_alarm "devserver: DOWN — POST http://localhost:$DEV_PORT/mcp -> $code (expected 401) on $CONFIRM_ATTEMPTS consecutive probes. Process state is irrelevant here; the port is the truth."

    if [ "$DEV_FAILS" -ge "$MAX_CONSEC_RESTART_FAILS" ]; then
        log_alarm "devserver: $DEV_FAILS consecutive failed restarts — restart loop disabled, alarming only. Needs a human. Check $DEV_LOG."
        return 1
    fi

    if restart_devserver; then
        DEV_FAILS=0
        return 0
    fi
    DEV_FAILS=$((DEV_FAILS + 1))
    log_fail "devserver: recovery attempt $DEV_FAILS/$MAX_CONSEC_RESTART_FAILS did not restore service"
    return 1
}

# alpic tunnel — only reached once :3000 is proven healthy, so a failure here
# genuinely isolates the tunnel rather than blaming it for a dead app. The
# public host is stable, so a restart is a real fix.
probe_tunnel() {
    http_code "$1/mcp" POST
}

restart_tunnel() {
    local i code pids app_url="$1"

    if [ "$DRY_RUN" = "1" ]; then
        log_warn "tunnel: --dry-run set; would have killed and restarted 'alpic tunnel'. No action taken."
        return 1
    fi
    if [ "$NVM_READY" != "1" ]; then
        log_fail "tunnel: refusing to restart — node 24 is not selectable (see nvm error above)."
        return 1
    fi

    pids=$(tree_pids_for_pattern 'alpic tunnel' | sort -un | tr '\n' ' ')
    log_action "tunnel: killing 'alpic tunnel' tree"
    terminate_pids "tunnel" $pids || true

    log_action "tunnel: starting './node_modules/.bin/alpic tunnel --port $DEV_PORT' in $APP_DIR under node 24 (log: $TUNNEL_LOG)"
    spawn_detached "$TUNNEL_LOG" ./node_modules/.bin/alpic tunnel --port "$DEV_PORT" >/dev/null

    for i in $(seq 1 "$TUNNEL_RECOVER_ATTEMPTS"); do
        sleep 2
        code=$(probe_tunnel "$app_url")
        if [ "$code" = "401" ]; then
            log_ok "tunnel: RECOVERED — POST $app_url/mcp -> 401 after ${i} probe(s)"
            return 0
        fi
    done

    code=$(probe_tunnel "$app_url")
    log_fail "tunnel: RESTART FAILED — POST $app_url/mcp -> $code after $((TUNNEL_RECOVER_ATTEMPTS * 2))s. Public endpoint is DOWN. Check $TUNNEL_LOG."
    return 1
}

TUNNEL_FAILS=0
check_tunnel() {
    local app_url="$1" code
    if code=$(confirm_probe "tunnel" 401 probe_tunnel "$app_url"); then
        [ "$TUNNEL_FAILS" -gt 0 ] && log_ok "tunnel: recovered; clearing failure count ($TUNNEL_FAILS)"
        TUNNEL_FAILS=0
        log_ok "tunnel: serving — POST $app_url/mcp -> 401"
        return 0
    fi

    log_alarm "tunnel: DOWN — POST $app_url/mcp -> $code (expected 401) on $CONFIRM_ATTEMPTS consecutive probes, while localhost:$DEV_PORT is healthy, so the tunnel is the broken link."

    if [ "$TUNNEL_FAILS" -ge "$MAX_CONSEC_RESTART_FAILS" ]; then
        log_alarm "tunnel: $TUNNEL_FAILS consecutive failed restarts — restart loop disabled, alarming only. Needs a human. Check $TUNNEL_LOG."
        return 1
    fi

    if restart_tunnel "$app_url"; then
        TUNNEL_FAILS=0
        return 0
    fi
    TUNNEL_FAILS=$((TUNNEL_FAILS + 1))
    log_fail "tunnel: recovery attempt $TUNNEL_FAILS/$MAX_CONSEC_RESTART_FAILS did not restore the public endpoint"
    return 1
}

# Stale baked-in metadata — the check the old watchdog could not express.
# A 401 from /mcp is emitted by local Express middleware with ZERO contact with
# AuthPlane; it is returned identically whether the AS is up, down, or three
# rotations stale. This compares what the server ADVERTISES against what
# app/.env currently says, which is the only signal that separates "healthy"
# from "cheerfully serving a dead issuer".
check_metadata() {
    local app_url="$1" issuer="$2" url body advertised
    url="$app_url/.well-known/oauth-protected-resource/mcp"
    body=$(http_body "$url")

    if [ -z "$body" ]; then
        log_warn "metadata: could not fetch GET $url (empty response) — cannot evaluate staleness this iteration"
        return 1
    fi

    advertised=$(norm_url "$(json_first_auth_server "$body")")
    if [ -z "$advertised" ]; then
        log_warn "metadata: GET $url returned no authorization_servers[0] — cannot evaluate staleness this iteration"
        return 1
    fi

    if [ "$advertised" = "$issuer" ]; then
        log_ok "metadata: fresh — $url advertises authorization_servers[0]=$advertised, matches AUTHPLANE_ISSUER in app/.env"
        return 0
    fi

    log_alarm "metadata: STALE — $url advertises authorization_servers[0]=$advertised but app/.env AUTHPLANE_ISSUER=$issuer"
    log_alarm "metadata: the dev server baked the OLD issuer into its routes at boot. Every surface looks healthy and ALL AUTH FAILS. FIX: restart the dev server so it re-runs OAuth discovery. NOT automated — a restart here is indistinguishable from restarting a healthy server, so it is a human call."
    return 1
}

# =================================================================== iteration =
# Called from inside an `if`, which suppresses errexit for its whole dynamic
# extent — a transient curl or a failing check can never kill the supervisor.
run_iteration() {
    local issuer app_url

    check_cloudflared || true          # alarm only; never gates, never restarts

    if ! issuer=$(read_issuer); then
        log_alarm "issuer: AUTHPLANE_ISSUER not found in $ENV_FILE — skipping devserver, tunnel and metadata checks"
        return 1
    fi
    app_url=$(read_app_url)

    if ! check_issuer "$issuer"; then
        log_warn "skipping devserver, tunnel and metadata checks this iteration (issuer down)"
        return 1
    fi

    if ! check_devserver; then
        log_warn "skipping tunnel and metadata checks this iteration (dev server not serving)"
        return 1
    fi

    if ! check_tunnel "$app_url"; then
        log_warn "skipping metadata check this iteration (public endpoint not serving, so its metadata document is not trustworthy)"
        return 1
    fi

    check_metadata "$app_url" "$issuer" || return 1
    return 0
}

# ======================================================================== main =
usage() {
    cat <<'EOF'
supervise.sh — health supervisor for the pr-radar dev stack.

Probes, in dependency order, and skips later checks when an earlier one fails:
  cloudflared  localhost:20241-20245 /ready, readyConnections >= 1  ALARM ONLY
  issuer       $AUTHPLANE_ISSUER/.well-known/oauth-authorization-server == 200
                                                                     ALARM ONLY (gates the rest)
  devserver    POST localhost:3000/mcp == 401                        RESTARTS
  tunnel       POST <public host>/mcp == 401                         RESTARTS
  metadata     <public host>/.well-known/oauth-protected-resource/mcp
               authorization_servers[0] == AUTHPLANE_ISSUER          ALARM ONLY

Usage:
  infra/supervise.sh                 run the loop in the foreground
  infra/supervise.sh --once          run one iteration, then exit
  infra/supervise.sh --dry-run       probe and alarm only; never kill or start
  infra/supervise.sh --interval 20   seconds between iterations (default 15)
  infra/supervise.sh --stop          stop a running supervisor
  infra/supervise.sh --status        report whether one is running
  infra/supervise.sh --help          this text

Logs and the pidfile live in infra/logs/ (gitignored).
Override the public host with PR_RADAR_APP_URL or infra/urls.env (APP_URL=...).
EOF
}

# Never report "stopped" without confirming the process is gone — reporting
# success while nothing happened is the failure mode this whole script exists
# to stop repeating.
cmd_stop() {
    local owner i
    if ! owner=$(pidfile_owner); then
        printf 'supervise.sh: no running supervisor (no live pid in %s)\n' "$PID_FILE"
        return 1
    fi

    kill -TERM "$owner" 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if ! kill -0 "$owner" 2>/dev/null; then
            rm -f "$PID_FILE"
            printf 'supervise.sh: stopped (pid %s exited after TERM)\n' "$owner"
            return 0
        fi
        sleep 1
    done

    printf 'supervise.sh: pid %s ignored TERM for 10s, sending KILL\n' "$owner" >&2
    kill -KILL "$owner" 2>/dev/null || true
    sleep 2
    if kill -0 "$owner" 2>/dev/null; then
        printf 'supervise.sh: FAILED to stop pid %s (still alive after KILL)\n' "$owner" >&2
        return 1
    fi
    rm -f "$PID_FILE"
    printf 'supervise.sh: stopped (pid %s killed)\n' "$owner"
    return 0
}

cmd_status() {
    local owner
    if owner=$(pidfile_owner); then
        printf 'supervise.sh: running (pid %s), log %s\n' "$owner" "$LOG_FILE"
        return 0
    fi
    printf 'supervise.sh: not running\n'
    return 1
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --once)     ONCE=1; shift ;;
            --dry-run)  DRY_RUN=1; shift ;;
            --interval) INTERVAL="${2:-15}"; shift 2 ;;
            --stop)     mkdir -p "$RUN_DIR"; cmd_stop; exit $? ;;
            --status)   mkdir -p "$RUN_DIR"; cmd_status; exit $? ;;
            -h|--help)  usage; exit 0 ;;
            *)          printf 'supervise.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
        esac
    done

    mkdir -p "$RUN_DIR"
    acquire_lock || exit 1
    trap on_exit EXIT
    trap on_signal INT TERM HUP

    log_ok "supervisor starting (pid $$, interval ${INTERVAL}s, once=$ONCE, dry-run=$DRY_RUN)"
    log_ok "repo=$REPO_ROOT env=$ENV_FILE log=$LOG_FILE"
    load_nvm || true
    if ! command -v lsof >/dev/null 2>&1; then
        log_fail "lsof not found — port checks cannot run; the dev-server check will be unreliable"
    fi

    while true; do
        if ! run_iteration; then
            log_warn "iteration ended with an unhealthy or skipped check; supervisor continues"
        fi
        [ "$ONCE" = "1" ] && break
        # Laptop sleep produces multi-minute gaps between iterations. Nothing
        # here derives state from elapsed time; every check re-probes from
        # scratch and every wait is a bounded attempt count, not a deadline.
        interruptible_sleep "$INTERVAL"
    done

    log_ok "supervisor exiting"
}

# Only run when executed, not when sourced. Sourcing lets the checks be driven
# individually against stubs, so failure paths can be exercised without taking
# the real stack down to test it.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
