#!/usr/bin/env bash
# Starts the whole fraud demo with one command and waits until every piece is healthy:
#
#   Java scoring API (8080)  ->  Node replay server (8081)  ->  React dashboard (5173)
#
# Usage:  ./start.sh            start everything and open the dashboard in your browser
#         ./start.sh --no-open  start everything without opening a browser
# Stop:   Ctrl+C in this terminal stops everything this script started.
#
# While running it keeps the Mac awake and restarts any service that crashes.
# Logs go to logs/. Works with macOS's built-in bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
API_PORT=8080
REPLAY_PORT=8081
DASH_PORT=5173
API_URL="http://localhost:$API_PORT"
REPLAY_URL="http://localhost:$REPLAY_PORT"
DASH_URL="http://localhost:$DASH_PORT"
JAR="$ROOT/api/target/fraud-api-1.0.0.jar"
MAX_RESTARTS=3
OPEN_BROWSER=1

API_PID=""
REPLAY_PID=""
DASH_PID=""
CAFFEINATE_PID=""

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_BROWSER=0 ;;
    -h | --help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

cleanup() {
  trap - EXIT INT TERM
  [ -n "$API_PID$REPLAY_PID$DASH_PID" ] || return 0
  echo
  say "Stopping the demo"
  for pid in $DASH_PID $REPLAY_PID $API_PID $CAFFEINATE_PID; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -f "$LOGS/start.pid"
  ok "All services stopped"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'die "start.sh failed unexpectedly at line $LINENO. See logs/ for details."' ERR

# --- 1. Prerequisites -------------------------------------------------------------------------

# A tool counts only if it actually runs: macOS ships a placeholder /usr/bin/java that just
# prints "Unable to locate a Java Runtime".
tool_works() {
  case $1 in
    java) java -version >/dev/null 2>&1 ;;
    *) "$1" --version >/dev/null 2>&1 ;;
  esac
}

# Use the tool from PATH, or fall back to a copy unpacked under ~/tools (how this Mac was set up),
# so the script also works in terminals that don't load the shell profile.
find_tool() {
  local name=$1 dir
  tool_works "$name" && return 0
  for dir in $2; do
    if [ -x "$dir/$name" ]; then
      PATH="$dir:$PATH"
      export PATH
      tool_works "$name" && return 0
    fi
  done
  return 1
}

port_owner() {
  # lsof exits non-zero when nothing is listening, which is the normal case here.
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR==2 {print $1 " (PID " $2 ")"}'
}

say "Checking prerequisites"
find_tool java "$HOME/tools/jdk-*/Contents/Home/bin" || die "Java 17+ not found. Install it, or run: source ~/.zshrc"
JAVA_MAJOR=$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/' || true)
[ "$JAVA_MAJOR" -ge 17 ] 2>/dev/null || die "Java 17+ required, found: $(java -version 2>&1 | head -1)"
ok "Java $JAVA_MAJOR"

find_tool node "$HOME/tools/node-*/bin" || die "Node.js 18+ not found. Install it, or run: source ~/.zshrc"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required, found $(node -v)"
ok "Node.js $(node -v)"

for f in artifacts/fraud_autoencoder.onnx artifacts/metrics.json data/replay.csv; do
  [ -f "$ROOT/$f" ] || die "Missing $f. Run the Phase 1 training script: .venv/bin/python ml/train.py"
done
ok "Model, metrics and replay data present"

for port in $API_PORT $REPLAY_PORT $DASH_PORT; do
  owner=$(port_owner "$port")
  [ -z "$owner" ] || die "Port $port is already in use by $owner. If it's an earlier demo, run ./stop.sh first."
done
ok "Ports $API_PORT, $REPLAY_PORT, $DASH_PORT are free"

# --- 2. Build anything that's missing ----------------------------------------------------------

mkdir -p "$LOGS"
echo $$ >"$LOGS/start.pid" # lets stop.sh stop this supervisor too
say "Preparing builds (logs in logs/)"
if [ ! -f "$JAR" ]; then
  find_tool mvn "$HOME/tools/apache-maven-*/bin" || die "The API jar isn't built and Maven isn't installed."
  echo "    Building the Java API (first run only, ~20s)…"
  (cd "$ROOT/api" && mvn -q -B -DskipTests package) >"$LOGS/build-api.log" 2>&1 ||
    die "Java build failed. See logs/build-api.log"
fi
ok "Java API jar"

for app in replay dashboard; do
  if [ ! -d "$ROOT/$app/node_modules" ]; then
    echo "    Installing $app packages from package-lock.json (first run only)…"
    (cd "$ROOT/$app" && npm ci --no-audit --no-fund) >"$LOGS/install-$app.log" 2>&1 ||
      die "npm install failed for $app. See logs/install-$app.log"
  fi
done
ok "Node packages"

(cd "$ROOT/dashboard" && node_modules/.bin/vite build) >"$LOGS/build-dashboard.log" 2>&1 ||
  die "Dashboard build failed. See logs/build-dashboard.log"
ok "Dashboard build"

# --- 3. Start services in order, waiting for each to be healthy --------------------------------

start_api() {
  (cd "$ROOT/api" && exec java -jar "$JAR" --server.port=$API_PORT) >>"$LOGS/api.log" 2>&1 &
  API_PID=$!
}
start_replay() {
  (cd "$ROOT/replay" && API_URL=$API_URL PORT=$REPLAY_PORT exec node src/server.js --mode=demo --rate=3) >>"$LOGS/replay.log" 2>&1 &
  REPLAY_PID=$!
}
start_dashboard() {
  (cd "$ROOT/dashboard" && exec node_modules/.bin/vite preview --port $DASH_PORT --strictPort) >>"$LOGS/dashboard.log" 2>&1 &
  DASH_PID=$!
}

# wait_healthy NAME URL EXPECTED_TEXT PID LOGFILE TIMEOUT_SECONDS
wait_healthy() {
  local name=$1 url=$2 expect=$3 pid=$4 log=$5 timeout=$6 tries=0 body
  while [ $tries -lt $((timeout * 4)) ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "    Last lines of logs/$log:"
      tail -n 15 "$LOGS/$log" | sed 's/^/      /'
      die "$name stopped during startup."
    fi
    body=$(curl -fsS -m 2 "$url" 2>/dev/null || true)
    case "$body" in *"$expect"*) return 0 ;; esac
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "    Last lines of logs/$log:"
  tail -n 15 "$LOGS/$log" | sed 's/^/      /'
  die "$name did not become healthy within ${timeout}s ($url)."
}

say "Starting services"
start_api
wait_healthy "Java scoring API" "$API_URL/health" '"status":"UP"' "$API_PID" api.log 60
ok "Java scoring API      $API_URL/health"
start_replay
wait_healthy "Replay server" "$REPLAY_URL/health" '"connected":true' "$REPLAY_PID" replay.log 30
ok "Replay server         $REPLAY_URL/health (demo mode, 3 transactions/s)"
start_dashboard
wait_healthy "Dashboard" "$DASH_URL" 'id="root"' "$DASH_PID" dashboard.log 30
ok "Dashboard             $DASH_URL"

# Keep the Mac from sleeping while the demo runs (stops automatically with this script).
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w $$ &
  CAFFEINATE_PID=$!
fi

echo
printf '\033[32m\033[1m  Demo is running:  %s\033[0m\n' "$DASH_URL"
echo "  Press Restart on the dashboard right before you present: the scripted fraud plays 20s later."
echo "  Ctrl+C here stops everything."
echo
[ $OPEN_BROWSER -eq 1 ] && command -v open >/dev/null 2>&1 && open "$DASH_URL"

# --- 4. Supervise: restart anything that crashes ------------------------------------------------

API_RESTARTS=0
REPLAY_RESTARTS=0
DASH_RESTARTS=0
while true; do
  sleep 2
  if ! kill -0 "$API_PID" 2>/dev/null; then
    [ $API_RESTARTS -lt $MAX_RESTARTS ] || die "Java scoring API keeps crashing. See logs/api.log"
    API_RESTARTS=$((API_RESTARTS + 1))
    warn "Java scoring API stopped; restarting (the dashboard shows 'Scoring API unavailable' until it's back)"
    start_api
    wait_healthy "Java scoring API" "$API_URL/health" '"status":"UP"' "$API_PID" api.log 60
    ok "Java scoring API is back"
  fi
  if ! kill -0 "$REPLAY_PID" 2>/dev/null; then
    [ $REPLAY_RESTARTS -lt $MAX_RESTARTS ] || die "Replay server keeps crashing. See logs/replay.log"
    REPLAY_RESTARTS=$((REPLAY_RESTARTS + 1))
    warn "Replay server stopped; restarting (the stream starts over from the beginning)"
    start_replay
    wait_healthy "Replay server" "$REPLAY_URL/health" '"connected":true' "$REPLAY_PID" replay.log 30
    ok "Replay server is back"
  fi
  if ! kill -0 "$DASH_PID" 2>/dev/null; then
    [ $DASH_RESTARTS -lt $MAX_RESTARTS ] || die "Dashboard server keeps crashing. See logs/dashboard.log"
    DASH_RESTARTS=$((DASH_RESTARTS + 1))
    warn "Dashboard server stopped; restarting"
    start_dashboard
    wait_healthy "Dashboard" "$DASH_URL" 'id="root"' "$DASH_PID" dashboard.log 30
    ok "Dashboard server is back"
  fi
done
