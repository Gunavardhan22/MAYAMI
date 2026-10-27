#!/usr/bin/env bash
# Starts the whole MAYAMI project locally on macOS/Linux (start.cmd / start.ps1 do the same on Windows):
#   1. sets up backend/.venv and backend/.env if missing
#   2. installs and builds the Chrome extension into extension/dist
#   3. runs the backend on http://localhost:8000 (Ctrl+C to stop)
# Flags: --dev  run the extension's Vite dev server (rebuilds on save) instead of a one-off build
#        --skip-build  don't touch the extension
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$root/backend"
extension="$root/extension"
dev=0
skip_build=0
for arg in "$@"; do
  case "$arg" in
    --dev) dev=1 ;;
    --skip-build) skip_build=1 ;;
    *) echo "Unknown option: $arg (use --dev or --skip-build)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }

# --- configuration -------------------------------------------------------------------
if [[ ! -f "$backend/.env" ]]; then
  cp "$backend/.env.example" "$backend/.env"
  warn "Created backend/.env - put your GOOGLE_API_KEY in it, then run this again."
  exit 1
fi
if ! grep -qE '^GOOGLE_API_KEY=\S+' "$backend/.env"; then
  warn "backend/.env has no GOOGLE_API_KEY. Add it, then run this again."
  exit 1
fi

# --- backend environment -------------------------------------------------------------
python="$backend/.venv/bin/python"
if [[ ! -x "$python" ]]; then
  step "Creating backend/.venv and installing dependencies (first run only, a few minutes)"
  python3 -m venv "$backend/.venv"
  "$python" -m pip install --upgrade pip
  "$python" -m pip install -r "$backend/requirements.txt"
fi

# A MAYAMI backend that is already up is fine; anything else on the port is a real conflict.
if curl -fsS --max-time 3 http://127.0.0.1:8000/health 2>/dev/null | grep -q '"status":"ok"'; then
  printf '\n\033[32mThe MAYAMI backend is already running on http://localhost:8000.\033[0m\n'
  backend_running=1
elif (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; then
  warn "Port 8000 is used by another program. Stop it, then run this again."
  exit 1
else
  backend_running=0
fi

# --- extension -----------------------------------------------------------------------
dev_pid=""
if [[ $skip_build -eq 0 ]]; then
  cd "$extension"
  if [[ ! -d node_modules ]]; then
    step "Installing the extension's Node modules"
    npm install --no-audit --no-fund
  fi
  if [[ $dev -eq 1 ]]; then
    step "Starting the extension dev server (rebuilds extension/dist on save)"
    npm run dev &
    dev_pid=$!
    trap '[[ -n "$dev_pid" ]] && kill "$dev_pid" 2>/dev/null || true' EXIT
  else
    step "Building the Chrome extension"
    npm run build
  fi
fi

printf '\n\033[32mExtension: load (or reload) extension/dist in chrome://extensions (Developer mode > Load unpacked).\n'
printf 'Options:   server URL and API key are pre-filled from backend/.env; the page shows whether it is connected.\033[0m\n'

# --- backend -------------------------------------------------------------------------
if [[ $backend_running -eq 1 ]]; then
  # Keep the dev server alive in the foreground if one was started; otherwise we're done.
  [[ -n "$dev_pid" ]] && wait "$dev_pid"
  exit 0
fi
step "Starting the backend on http://localhost:8000 (Ctrl+C to stop)"
cd "$backend"
"$python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --ws-ping-interval 20
