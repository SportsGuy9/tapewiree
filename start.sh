#!/usr/bin/env sh
# Tapewire launcher for macOS / Linux: installs on first run, starts the server and opens the browser.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --omit=dev || exit 1
[ -f .env ] || cp .env.example .env
PORT="${PORT:-8787}"
( sleep 2; (command -v open >/dev/null && open "http://localhost:$PORT") || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT") ) >/dev/null 2>&1 &
exec node server/server.js
