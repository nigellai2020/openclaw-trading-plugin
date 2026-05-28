# trading-plugin

OpenClaw plugin for trading data, paper trading, live trading (Hyperliquid), copy-trading, and backtesting.

## Install

```bash
npm install
openclaw plugins install -l .
openclaw gateway restart
```

## Configuration

Config keys defined in `openclaw.plugin.json`. Set them in `~/.openclaw/config.json5`:

```json5
{
  plugins: {
    entries: {
      "trading-plugin": {
        config: {
          baseUrl: "https://agent02.decom.dev",
          tradingBotUrl: "https://trading-agent.decom.dev",
          billingEnvironment: "test", // "test" or "prod"
          nostrPrivateKey: "${NOSTR_PRIVATE_KEY}",
          walletAgentUrl: "https://wallet-agent.decom.dev",
          settlementEngineUrl: "https://settlement-agent.decom.dev",
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
| `prepare_agent_creation`  | Preflight for direct or copy-agent creation — summarize billing, NFT, or vault setup. Pass `copiedFromAgentId` to preflight a copy agent |
| `setup_live_wallet`       | Store agent wallet key in TEE and register in backend                       |
| `deploy_agent`            | Create agent (direct or copy), run billing setup, notify bot, register trader (live), log action, verify. Pass `copiedFromAgentId` to create a copy agent |
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
| `manage-agents`      | Guided workflow for listing, updating, and deleting agents |
| `manage-wallets`     | Guided workflow for listing, updating, and deleting wallets |
| `market-data`        | Guided workflow for current token prices and historical market data |
| `backtest`           | Guided workflow for running backtests    |
| `strategy-reference` | Loads the canonical trading strategy reference from `skills/strategy-reference/strategy.md` |
| `nostr-identity`     | Retrieve user's Nostr identity           |
