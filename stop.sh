#!/usr/bin/env bash
# Stops demo services left running on ports 8080 (Java API), 8081 (replay server) and 5173
# (dashboard), for example after a terminal was closed without Ctrl+C.
# Only stops processes that are recognizably part of this demo; anything else is reported, not killed.
set -uo pipefail

stop_port() {
  local port=$1 pattern=$2 label=$3 pid cmd
  pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -z "$pid" ]; then
    echo "  $label (port $port): not running"
    return
  fi
  cmd=$(ps -o command= -p "$pid")
  case "$cmd" in
    *$pattern*)
      kill "$pid" && echo "  $label (port $port): stopped PID $pid"
      ;;
    *)
      echo "  $label (port $port): in use by another program, not stopped: $cmd"
      ;;
  esac
}

echo "Stopping fraud demo services"

# Stop a running start.sh first; otherwise it would restart the services stopped below.
PIDFILE="$(cd "$(dirname "$0")" && pwd)/logs/start.pid"
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q "start.sh"; then
    kill -TERM "$pid" && echo "  start.sh (PID $pid): stopped, along with the services it started"
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -f "$PIDFILE"
fi
stop_port 8080 "fraud-api" "Java scoring API"
stop_port 8081 "server.js" "Replay server"
stop_port 5173 "vite" "Dashboard"
