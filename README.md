# trading-plugin

OpenClaw plugin for trading data, paper trading, live trading (Hyperliquid), copy-trading, and backtesting.

Copyright (c) 2026 OpenSwap — Licensed under the [MIT License](./LICENSE).

---

## ⚠️ IMPORTANT — READ BEFORE USING

**BY INSTALLING, RUNNING, COPYING, DISTRIBUTING, OR OTHERWISE USING THIS
SOFTWARE YOU AGREE TO THE TERMS BELOW AND IN [`DISCLAIMER.md`](./DISCLAIMER.md).**

1. **Not financial advice.** Nothing in this plugin is financial, investment,
   legal, tax, or trading advice. You are solely responsible for every
   decision you make and every trade you execute. Consult a qualified
   professional before acting.
2. **Use at your own risk.** Trading digital assets, perpetuals, and other
   instruments is inherently risky and may result in **total loss** of
   capital. Past, paper, or backtested performance is **not** indicative
   of future results.
3. **No warranty.** The software is provided "AS IS", without warranty of
   any kind, express or implied.
4. **No liability.** To the maximum extent permitted by law, the author(s)
   and copyright holder(s) are **not liable** for any direct, indirect,
   incidental, special, consequential, exemplary, or punitive damages
   (including loss of funds, profits, data, or keys) arising from your
   use of, or inability to use, the software or any third-party service
   it integrates with.
5. **Your keys, your funds.** You are solely responsible for safeguarding
   your `NOSTR_PRIVATE_KEY`, wallet keys, and any credentials. The
   author(s) do not custody or have access to your funds.
6. **Compliance is on you.** You are responsible for complying with all
   laws, regulations, and sanctions applicable to you.

The full disclaimer — including a US$100 aggregate-liability cap where
permitted, an indemnification clause, an arbitration clause, and the
complete limitation of liability — is in [`DISCLAIMER.md`](./DISCLAIMER.md).
Third-party components and notices are listed in [`NOTICE`](./NOTICE).

**If you do not agree to these terms, do not install or use this software.**

---

## Install

```bash
npm install
openclaw plugins install -l .
openclaw gateway restart
```

## Configuration

The only required setting is `nostrPrivateKey`. Every other key has a default in
`openclaw.plugin.json` and is applied automatically — set a key in your config only to
override its default. Add the config to `~/.openclaw/openclaw.json`:

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
  },
}
```

## Tools

### Market Data

| Tool               | Description                       |
| ------------------ | --------------------------------- |
| `get_token_prices` | Get current live token prices for all tracked tokens or a normalized symbol list |
| `get_ohlc`         | Get OHLC candle data for a symbol |
| `get_agent_trades` | Get past trades / trade history for a single agent with optional `range` (`1d`, `7d`, etc.) or explicit timestamps |
| `get_open_positions` | Get the current open positions for a single agent |

`get_token_prices` accepts an optional `symbols` array. OpenClaw should normalize user input before calling it and pass uppercase base-token symbols like `ETH` or `BTC`. If malformed symbols are provided, the tool returns a validation error so OpenClaw can retry.

### Identity

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get_nostr_identity`     | Retrieve user's Nostr npub and public key        |

### Session & Agent Management

| Tool                      | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `init_trading_session`    | Initialize session: check keys and optionally list wallets                 |
| `prepare_agent_creation`  | Preflight for direct or copy-agent creation and summarize the normalized execution plan. Pass `copiedFromAgentId` to preflight a copy agent |
| `request_hyperliquid_setup_flow` | Request a secure wallet setup link to register a new Hyperliquid API wallet with OpenSwap |
| `deploy_agent`            | Create agent (direct or copy), notify bot, register trader (live), log action, and verify. Pass `copiedFromAgentId` to create a copy agent |
| `get_agent`               | Get agent details by ID                                                     |
| `update_agent`            | Update only the requested agent fields across the supported backends. Pass `copiedFromAgentId` to switch the source agent being followed |
| `get_hyperliquid_balance` | Get USDC balance of a Hyperliquid master wallet                             |
| `list_wallets`            | List all wallets registered to the current user                             |
| `update_wallet`           | Update a wallet by address, including Hyperliquid metadata                  |
| `delete_wallet`           | Delete a wallet by address                                                  |

### Backtesting

| Tool                  | Description                           |
| --------------------- | ------------------------------------- |
| `create_backtest`     | Submit a strategy-based backtest job; if the user mentions a timezone, OpenClaw should resolve it before calling the tool, otherwise naive dates/times fall back to the OpenClaw runtime timezone, then UTC. If `startTime` and/or `endTime` are omitted, the plugin defaults to a rolling 30-day window |
| `get_backtests`       | List manual backtests for the authenticated user |
| `get_backtest_job`    | Poll backtest job progress and status |
| `get_backtest_result` | Get completed backtest results        |

## Skills

| Skill                | Description                              |
| -------------------- | ---------------------------------------- |
| `trade`              | Guided workflow for creating new paper, live, or copy agents |
| `manage-agents`      | Guided workflow for listing, updating, reactivating, and deleting agents |
| `manage-wallets`     | Guided workflow for listing, updating, and deleting wallets |
| `market-data`        | Guided workflow for current token prices and historical market data |
| `backtest`           | Guided workflow for running backtests    |
| `strategy-reference` | Loads the canonical trading strategy reference from `skills/strategy-reference/strategy.md` |
| `nostr-identity`     | Retrieve user's Nostr identity           |

---

## Legal

- **License:** [MIT](./LICENSE) — `Copyright (c) 2026 OpenSwap`
- **Full disclaimer (no advice / no warranty / no liability / arbitration):**
  see [`DISCLAIMER.md`](./DISCLAIMER.md)
- **Third-party notices:** see [`NOTICE`](./NOTICE)

The author(s) and copyright holder(s) provide this software **as-is** and
disclaim all warranties and liability to the maximum extent permitted by
applicable law. By using this software you accept the terms in
[`DISCLAIMER.md`](./DISCLAIMER.md).
