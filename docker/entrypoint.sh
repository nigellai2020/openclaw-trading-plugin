#!/bin/sh
set -e

cd /home/node/trading-plugin && rm -rf node_modules && npm install --include=dev

# Compile TS to dist/ — newer OpenClaw images require compiled JS, not TS source
npm run build

# Normalize config location and schema before any openclaw command.
node /home/node/trading-plugin/docker/bootstrap-openclaw-config.cjs

# Plugin loads via plugins.load.paths (dev path, TS source allowed).
# install is redundant and fails on newer images that require compiled output.
openclaw plugins install -l /home/node/trading-plugin || true

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  openclaw channels add --channel telegram --token "$TELEGRAM_BOT_TOKEN" || true
fi

exec node /app/openclaw.mjs gateway --bind lan --port 18789
