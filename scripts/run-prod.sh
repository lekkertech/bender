#!/usr/bin/env bash
set -euo pipefail

# Run the Slack bot in production.
# - Ensures we are in the repo root
# - Builds the project if needed
# - Starts the compiled app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure environment
export NODE_ENV=${NODE_ENV:-production}

# Ensure Node is available (support nvm environments)
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[run-prod] ERROR: node not found in PATH. Install Node or expose it to systemd." >&2
  exit 127
fi

NODE_BIN="$(command -v node)"

# Build if dist is missing or older than sources
if [ ! -f dist/index.js ] || find src -type f -newer dist/index.js | read; then
  echo "[run-prod] Building project..."
  if [ -x node_modules/typescript/bin/tsc ]; then
    "$NODE_BIN" node_modules/typescript/bin/tsc --project tsconfig.json
  elif [ -x node_modules/.bin/tsc ]; then
    # Fallback if Typescript bin exists with a shebang
    "$NODE_BIN" node_modules/.bin/tsc --project tsconfig.json
  else
    echo "[run-prod] ERROR: TypeScript not installed. Run 'npm install' before starting under systemd." >&2
    exit 1
  fi
fi

echo "[run-prod] Starting bot..."
exec "$NODE_BIN" dist/index.js
