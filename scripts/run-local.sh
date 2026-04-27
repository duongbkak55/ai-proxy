#!/usr/bin/env bash
# scripts/run-local.sh
#
# Bring up the full ai-proxy demo stack on localhost:
#   - rebuilds dist/ if stale, demo bundle + chat-config.js with current env
#   - starts the proxy (with CORS for the web demo origin)
#   - starts a python http.server hosting demo/web/
#   - traps SIGINT/SIGTERM to clean up both child processes
#
# Usage:
#   cp scripts/env.local.example .test-run/env.local
#   # edit .test-run/env.local — fill ANTHROPIC_API_KEY + OMC_DEMO_BEARER_TOKEN
#   bash scripts/run-local.sh
#
# Or via npm:
#   npm run dev:local
#
# Works on Linux/macOS bash and Git-Bash on Windows.

set -euo pipefail

# Resolve repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-.test-run/env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[run-local] missing $ENV_FILE" >&2
  echo "[run-local] copy template:" >&2
  echo "    cp scripts/env.local.example $ENV_FILE" >&2
  echo "[run-local] then fill ANTHROPIC_API_KEY + OMC_DEMO_BEARER_TOKEN and rerun." >&2
  exit 1
fi

# Load env: export everything declared in env.local, ignoring blanks/comments.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

LOCAL_PROXY_PORT="${LOCAL_PROXY_PORT:-11500}"
LOCAL_WEB_PORT="${LOCAL_WEB_PORT:-8001}"
LOCAL_PROXY_CONFIG="${LOCAL_PROXY_CONFIG:-.test-run/proxy.jsonc}"

if [[ ! -f "$LOCAL_PROXY_CONFIG" ]]; then
  echo "[run-local] proxy config not found: $LOCAL_PROXY_CONFIG" >&2
  echo "[run-local] generate one with:" >&2
  echo "    node dist/cli.js config print > $LOCAL_PROXY_CONFIG" >&2
  echo "[run-local] then edit listen.port + auth.tokensFile + audit.dir as needed." >&2
  exit 1
fi

# ── Helpers ────────────────────────────────────────────────────────────────
have_python() {
  # On Windows, both `python3` and `python` may be the Microsoft Store stub
  # that exists in PATH but fails on invocation. Probe each with --version
  # before committing to it.
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" --version >/dev/null 2>&1; then
        PYTHON_BIN="$cand"
        return 0
      fi
    fi
  done
  return 1
}

kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "[run-local] killing existing process on :$port (lsof: $pids)"
      kill -9 $pids 2>/dev/null || true
    fi
  elif command -v netstat >/dev/null 2>&1; then
    # Git-Bash / Windows path. netstat -ano reports PID in last column.
    local pids
    pids="$(netstat -ano 2>/dev/null | awk -v p=":$port" '$2 ~ p && $4 == "LISTENING" {print $5}' | sort -u)"
    if [[ -n "$pids" ]]; then
      echo "[run-local] killing existing process on :$port (netstat: $pids)"
      for pid in $pids; do
        # Prefer Windows taskkill if available, else kill.
        if command -v taskkill >/dev/null 2>&1; then
          taskkill //F //PID "$pid" >/dev/null 2>&1 || true
        else
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
    fi
  fi
}

# ── Build steps ────────────────────────────────────────────────────────────
echo "[run-local] building TypeScript (dist/)…"
npm run build --silent

echo "[run-local] bundling demo + writing chat-config.js…"
npm run demo:build --silent

# ── Pre-flight: free the ports ─────────────────────────────────────────────
kill_port "$LOCAL_PROXY_PORT"
kill_port "$LOCAL_WEB_PORT"

# ── Start proxy ────────────────────────────────────────────────────────────
echo "[run-local] starting proxy on :$LOCAL_PROXY_PORT"
node dist/cli.js start --config "$LOCAL_PROXY_CONFIG" --port "$LOCAL_PROXY_PORT" \
  > .test-run/proxy.out 2>&1 &
PROXY_PID=$!

# ── Start static web ───────────────────────────────────────────────────────
if ! have_python; then
  echo "[run-local] python not found — install Python 3 or run \`npx --yes serve demo/web -p $LOCAL_WEB_PORT\` manually." >&2
  echo "[run-local] proxy is up; web server skipped." >&2
  WEB_PID=""
else
  echo "[run-local] starting web ($PYTHON_BIN) on :$LOCAL_WEB_PORT"
  "$PYTHON_BIN" -m http.server "$LOCAL_WEB_PORT" --directory demo/web \
    > .test-run/web.out 2>&1 &
  WEB_PID=$!
fi

# ── Cleanup on exit ────────────────────────────────────────────────────────
cleanup() {
  echo
  echo "[run-local] shutting down…"
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
  if [[ -n "${PROXY_PID:-}" ]]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Wait + show URLs ───────────────────────────────────────────────────────
sleep 1
cat <<EOF

[run-local] services up:
  proxy    →  http://127.0.0.1:$LOCAL_PROXY_PORT  (PID $PROXY_PID, log: .test-run/proxy.out)
  chat UI  →  http://127.0.0.1:$LOCAL_WEB_PORT/chat.html   ${WEB_PID:+(PID $WEB_PID, log: .test-run/web.out)}
  DLP sim  →  http://127.0.0.1:$LOCAL_WEB_PORT/index.html

  upstream →  ${OMC_PROXY_UPSTREAM:-https://api.anthropic.com}
  key env  →  ${OMC_PROXY_API_KEY_ENV:-ANTHROPIC_API_KEY} = $( key_var="${OMC_PROXY_API_KEY_ENV:-ANTHROPIC_API_KEY}"; key_val="${!key_var:-}"; [[ -n "$key_val" && "$key_val" != "sk-ant-REPLACE_ME" && "$key_val" != "REPLACE_ME" ]] && echo "set (real)" || echo "PLACEHOLDER — chat will 401 from upstream" )
  bearer   →  ${OMC_DEMO_BEARER_TOKEN:0:8}…${OMC_DEMO_BEARER_TOKEN: -4}
  model    →  ${OMC_DEMO_MODEL:-(default)}

  Ctrl+C to stop.
EOF

# Wait for proxy to exit (or signal). If proxy dies, take the web down too.
wait "$PROXY_PID"
cleanup
