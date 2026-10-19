#!/usr/bin/env bash
# Launch Chrome with consistent debugging port + user-data-dir.
# See _archive/research/ConnectionTokenInvestigation.md for why this exists.

set -euo pipefail

PORT=${PORT:-9222}
ISOLATED=${ISOLATED:-0}

if [[ "${1:-}" == "--isolated" || "$ISOLATED" == "1" ]]; then
  USER_DATA_DIR="${TMPDIR:-/tmp}/chrome-cdp-isolated"
  PROFILE="Default"
else
  if [[ "$(uname -s)" == "Darwin" ]]; then
    USER_DATA_DIR="${USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
  else
    USER_DATA_DIR="${USER_DATA_DIR:-$HOME/.config/google-chrome}"
  fi
  PROFILE="${PROFILE:-Default}"
fi

# Find chrome binary
if [[ "$(uname -s)" == "Darwin" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  CHROME=$(command -v google-chrome || command -v chromium-browser || command -v chrome || true)
fi
if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
  echo "Chrome not found. Install Chrome." >&2
  exit 1
fi

# Already running?
if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome already running on port $PORT. No-op."
  exit 0
fi

echo "Launching Chrome:"
echo "  Port: $PORT"
echo "  Profile: $USER_DATA_DIR / $PROFILE"

"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --profile-directory="$PROFILE" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  >/dev/null 2>&1 &

# Wait up to 10s for the port
for i in {1..20}; do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "Chrome up at http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done
echo "Chrome started but port $PORT did not open within 10s" >&2
exit 2
