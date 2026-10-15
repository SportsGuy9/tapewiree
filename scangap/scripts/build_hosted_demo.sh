#!/usr/bin/env bash
# Build the read-only hosted demo of the synthetic project into scangap/hosted-demo/.
# Requires the backend installed (pip install -e backend) and frontend deps (npm ci in frontend).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/hosted-demo"
export SCANGAP_DATA="${SCANGAP_DATA:-$HOME/.scangap}"
export SCANGAP_OFFLINE=1

python -m scangap.cli demo synthetic
rm -rf "$OUT" && mkdir -p "$OUT"
python -m scangap.cli export-static demo-synthetic "$OUT/demo"
python -m scangap.cli export-static demo-synthetic-after "$OUT/demo/after"
(cd "$ROOT/frontend" && rm -rf out-demo-build && NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STATIC_DEMO=1 npx next build >/dev/null)
mkdir -p "$OUT/app" && cp -r "$ROOT/frontend/out-demo-build/_next" "$OUT/app/_next" && rm -f "$OUT"/app/_next/static/chunks/polyfills-*.js
# full document (for any static host: GitHub Pages, S3, Netlify...)
cp "$ROOT/frontend/out-demo-build/index.html" "$OUT/standalone.html"
# fragment (for hosts that wrap pages in their own skeleton, e.g. claude.ai artifacts)
python "$ROOT/scripts/make_fragment.py" "$ROOT/frontend/out-demo-build/index.html" "$OUT/index.html"
echo "hosted demo in $OUT"
