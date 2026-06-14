# Installation

> ⚠️ **By installing this plugin you agree to [`DISCLAIMER.md`](./DISCLAIMER.md) and the [`LICENSE`](./LICENSE) (MIT).** This software is not financial advice, is provided "AS IS" without warranty, and the author(s) are not liable for any losses. See [`DISCLAIMER.md`](./DISCLAIMER.md) for the full terms.

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

Edit `~/.openclaw/openclaw.json` and add the plugin config. The only required field is
`nostrPrivateKey`; every other setting has a default in `openclaw.plugin.json` and is applied
automatically:

```json5
{
  plugins: {
    entries: {
      "trading-plugin": {
        config: {
          nostrPrivateKey: "${NOSTR_PRIVATE_KEY}",
        },
      },
    },
  }
}
```

Replace `${NOSTR_PRIVATE_KEY}` with your Nostr private key (hex). To override any default
(for example a custom Nostr relay), add that key alongside it, e.g. `nostrRelayUrl: "wss://your.relay"`.

The Nostr connection enables real-time trading notifications via Telegram. The plugin subscribes to NIP-04 kind-4 direct messages tagged to your derived Nostr public key and forwards supported events such as `fill_executed`, `backtest_completed`, and `agent_deactivated` to your Telegram chat.

## 4. Start the Gateway

```bash
openclaw gateway restart
```

You can now chat with the trading plugin via your Telegram bot.
