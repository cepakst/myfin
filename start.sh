#!/usr/bin/env bash
# macOS / Linux counterpart of start.bat: installs dependencies on first run, builds the app and opens it in the browser.
set -euo pipefail
cd "$(dirname "$0")"

pause_on_error() {
  echo "Nastala chyba."
  # keep the Terminal window open when started by double-click (start.command)
  [ -t 0 ] && read -r -p "Stiskněte Enter pro ukončení…" _ || true
  exit 1
}
trap pause_on_error ERR

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js není nainstalován. Stáhněte jej z https://nodejs.org (verze 22 nebo novější), případně: brew install node"
  [ -t 0 ] && read -r -p "Stiskněte Enter pro ukončení…" _ || true
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instaluji závislosti..."
  npm install --no-fund --no-audit
fi

echo "Sestavuji aplikaci..."
npm run build --silent

exec node dist/server/main.js --open
