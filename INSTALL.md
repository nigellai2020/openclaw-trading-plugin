# Installation

## 1. Install OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Follow the prompts to complete setup. Use defaults unless specified below:

- **Onboarding:** Quick start
- **Model provider:** Kimi K2.5 (paste your Kimi API key)
- **Channel:** Telegram (paste your bot token)

## 2. Install the Trading Plugin

```bash
git clone https://github.com/scom-repos/openclaw-trading-plugin.git
cd openclaw-trading-plugin
npm install
openclaw plugins install -l .
```

## 3. Configure the Plugin

Edit `~/.openclaw/openclaw.json` and add the plugin config:

```json
{
  "plugins": {
    "entries": {
      "trading-plugin": {
        "config": {
          "billingEnvironment": "test",
          "nostrPrivateKey": "${NOSTR_PRIVATE_KEY}",
          "nostrRelayUrl": "${NOSTR_RELAY_URL}" // optional, defaults to wss://nos.lol
        }
      }
    }
  }
}
```

Replace the placeholders:

- `${NOSTR_PRIVATE_KEY}` — your Nostr private key (hex)
- `${NOSTR_RELAY_URL}` — optional Nostr relay URL (defaults to `wss://nos.lol`)

The Nostr connection enables real-time trade fill notifications via Telegram. The plugin subscribes to NIP-04 kind-4 direct messages tagged to your derived Nostr public key and forwards only `fill_executed` events to your Telegram chat.

## 4. Start the Gateway

```bash
openclaw gateway restart
```

You can now chat with the trading plugin via your Telegram bot.
