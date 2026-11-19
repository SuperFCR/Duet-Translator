#!/usr/bin/env bash
# Run the project-local HyperFrames CLI from promo/, with telemetry off.
# On this WSL box (no sudo) it points HyperFrames at Playwright's chrome-headless-shell and the
# user-space libs/fonts under ~/.cache/st-e2e-libs. Elsewhere it falls back to HyperFrames' own
# managed Chrome (`scripts/hf.sh browser ensure`).
set -euo pipefail
promo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HYPERFRAMES_NO_TELEMETRY=1

if [ -z "${HYPERFRAMES_BROWSER_PATH:-}" ]; then
  shell="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$shell" ]; then export HYPERFRAMES_BROWSER_PATH="$shell"; fi
fi
libs="$HOME/.cache/st-e2e-libs"
if [ -d "$libs/root/usr/lib/x86_64-linux-gnu" ]; then
  export LD_LIBRARY_PATH="$libs/root/usr/lib/x86_64-linux-gnu:$libs/root/usr/lib/x86_64-linux-gnu/nss${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  [ -f "$libs/fonts.conf" ] && export FONTCONFIG_FILE="$libs/fonts.conf"
fi

cd "$promo"
exec "$promo/node_modules/.bin/hyperframes" "$@"
