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
          "mqttBrokerUrl": "${MQTT_BROKER_URL}", // optional
          "mqttPort": 8883, // optional
          "mqttUsername": "${MQTT_USERNAME}", // optional
          "mqttPassword": "${MQTT_PASSWORD}" // optional
        }
      }
    }
  }
}
```

Replace the placeholders:

- `${NOSTR_PRIVATE_KEY}` — your Nostr private key (hex)
- `${MQTT_BROKER_URL}` — MQTT broker hostname (e.g. `abc123.s1.eu.hivemq.cloud`)
- `${MQTT_USERNAME}` / `${MQTT_PASSWORD}` — MQTT credentials

The MQTT connection enables real-time trade fill notifications via Telegram. The plugin subscribes to the `fill_executions` topic and forwards events to your Telegram chat.

## 4. Start the Gateway

```bash
openclaw gateway restart
```

You can now chat with the trading plugin via your Telegram bot.
