const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), "workspace");
const pluginPath = "/home/node/trading-plugin";
const primaryConfigPath = path.join(openclawHome, "openclaw.json");

function readConfig(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const mergedConfig = readConfig(primaryConfigPath);

try {
  fs.rmSync(path.join(openclawHome, "agents", "main", "sessions"), {
    recursive: true,
    force: true,
  });
} catch {}

if (!mergedConfig.plugins) mergedConfig.plugins = {};
if (!mergedConfig.plugins.load) mergedConfig.plugins.load = {};
if (!Array.isArray(mergedConfig.plugins.load.paths)) {
  mergedConfig.plugins.load.paths = [];
}
if (!mergedConfig.plugins.load.paths.includes(pluginPath)) {
  mergedConfig.plugins.load.paths = [
    pluginPath,
    ...mergedConfig.plugins.load.paths.filter((entry) => entry !== pluginPath),
  ];
}
mergedConfig.plugins.load.paths = mergedConfig.plugins.load.paths.map((entry) =>
  typeof entry === "string" && entry.includes("trading-plugin") ? pluginPath : entry,
);

if (!mergedConfig.plugins.installs) mergedConfig.plugins.installs = {};
if (!mergedConfig.plugins.installs["trading-plugin"]) {
  mergedConfig.plugins.installs["trading-plugin"] = {};
}
mergedConfig.plugins.installs["trading-plugin"].sourcePath = pluginPath;
mergedConfig.plugins.installs["trading-plugin"].installPath = pluginPath;

if (!mergedConfig.plugins.entries) mergedConfig.plugins.entries = {};
if (!mergedConfig.plugins.entries["trading-plugin"]) {
  mergedConfig.plugins.entries["trading-plugin"] = {};
}
if (!mergedConfig.plugins.entries["trading-plugin"].config) {
  mergedConfig.plugins.entries["trading-plugin"].config = {};
}

const pluginConfig = mergedConfig.plugins.entries["trading-plugin"].config;
const env = process.env;

if (!mergedConfig.agents) mergedConfig.agents = {};
if (!mergedConfig.agents.defaults) mergedConfig.agents.defaults = {};
mergedConfig.agents.defaults.workspace = workspacePath;

if (!mergedConfig.gateway) mergedConfig.gateway = {};
if (!mergedConfig.gateway.mode) mergedConfig.gateway.mode = "local";
if (!mergedConfig.gateway.controlUi) mergedConfig.gateway.controlUi = {};
mergedConfig.gateway.controlUi.allowedOrigins = ["http://localhost:18789"];

if (env.PLUGIN_NOSTR_PRIVATE_KEY) pluginConfig.nostrPrivateKey = env.PLUGIN_NOSTR_PRIVATE_KEY;
if (env.PLUGIN_NOSTR_RELAY_URL) pluginConfig.nostrRelayUrl = env.PLUGIN_NOSTR_RELAY_URL;
if (env.PLUGIN_BASE_URL) pluginConfig.baseUrl = env.PLUGIN_BASE_URL;
if (env.PLUGIN_WALLET_AGENT_URL) pluginConfig.walletAgentUrl = env.PLUGIN_WALLET_AGENT_URL;
if (env.PLUGIN_SETTLEMENT_ENGINE_URL) {
  pluginConfig.settlementEngineUrl = env.PLUGIN_SETTLEMENT_ENGINE_URL;
}

fs.mkdirSync(openclawHome, { recursive: true });
const serialized = JSON.stringify(mergedConfig, null, 2) + "\n";
fs.writeFileSync(primaryConfigPath, serialized);
