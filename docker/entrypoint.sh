#!/bin/sh
set -e

cd /home/node/trading-plugin && rm -rf node_modules && npm install --include=dev

# Compile TS to dist/ — newer OpenClaw images require compiled JS, not TS source
npm run build

# Clear stale sessions that have host-specific paths baked in
rm -rf /home/node/.openclaw/agents/main/sessions

# Fix host paths in config before any openclaw command
node -e "
const fs = require('fs');
const configPath = '/home/node/.openclaw/openclaw.json';
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

// Fix plugin load paths to use container path
if (config.plugins && config.plugins.load && config.plugins.load.paths) {
  config.plugins.load.paths = config.plugins.load.paths.map(p =>
    p.includes('trading-plugin') ? '/home/node/trading-plugin' : p
  );
}

// Fix plugin install paths
if (config.plugins && config.plugins.installs && config.plugins.installs['trading-plugin']) {
  const inst = config.plugins.installs['trading-plugin'];
  inst.sourcePath = '/home/node/trading-plugin';
  inst.installPath = '/home/node/trading-plugin';
}

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries['trading-plugin']) config.plugins.entries['trading-plugin'] = {};
if (!config.plugins.entries['trading-plugin'].config) config.plugins.entries['trading-plugin'].config = {};

const pc = config.plugins.entries['trading-plugin'].config;
const env = process.env;

// Fix workspace path
if (config.agents && config.agents.defaults && config.agents.defaults.workspace) {
  config.agents.defaults.workspace = '/home/node/workspace';
}

// Allow control UI from localhost via Docker port mapping
if (!config.gateway) config.gateway = {};
if (!config.gateway.controlUi) config.gateway.controlUi = {};
config.gateway.controlUi.allowedOrigins = ['http://localhost:18789'];

if (env.PLUGIN_NOSTR_PRIVATE_KEY) pc.nostrPrivateKey = env.PLUGIN_NOSTR_PRIVATE_KEY;
if (env.PLUGIN_NOSTR_RELAY_URL) pc.nostrRelayUrl = env.PLUGIN_NOSTR_RELAY_URL;
if (env.PLUGIN_BASE_URL) pc.baseUrl = env.PLUGIN_BASE_URL;
if (env.PLUGIN_TRADING_BOT_URL) pc.tradingBotUrl = env.PLUGIN_TRADING_BOT_URL;
if (env.PLUGIN_WALLET_AGENT_URL) pc.walletAgentUrl = env.PLUGIN_WALLET_AGENT_URL;
if (env.PLUGIN_SETTLEMENT_ENGINE_URL) pc.settlementEngineUrl = env.PLUGIN_SETTLEMENT_ENGINE_URL;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
"

# Plugin loads via plugins.load.paths (dev path, TS source allowed).
# install is redundant and fails on newer images that require compiled output.
openclaw plugins install -l /home/node/trading-plugin || true

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  openclaw channels add --channel telegram --token "$TELEGRAM_BOT_TOKEN" || true
fi

exec node /app/openclaw.mjs gateway --bind lan --port 18789
