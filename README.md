# trading-plugin

OpenClaw plugin for trading data, paper trading, live trading (Hyperliquid), and backtesting.

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
| `get_token_prices` | Get live prices of all tokens     |
| `get_ohlc`         | Get OHLC candle data for a symbol |
| `get_leaderboard`  | Get leaderboard rows with optional pagination and filters |
| `get_leaderboard_filters` | Get leaderboard filter options for chains, pairs, modes, and market types |
| `get_agent_trades` | Get past trades / trade history for a single agent with optional `range` (`1d`, `7d`, etc.) or explicit timestamps |

### Identity

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get_nostr_identity`     | Retrieve user's Nostr npub and public key        |

### Session & Agent Management

| Tool                      | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `init_trading_session`    | Initialize session: check keys and optionally list wallets                 |
| `prepare_agent_creation`  | Preflight agent creation and summarize any required billing, NFT, or vault setup |
| `prepare_copy_agent`      | Validate source agent and optional wallet defaults before creating a copied live agent |
| `setup_live_wallet`       | Store agent wallet key in TEE and register in backend                       |
| `deploy_agent`            | Create agent, run any required billing setup, notify bot, register trader (live), log action, verify |
| `deploy_copy_agent`       | Create a live copy-trading agent from an existing source agent and sync follow-up systems |
| `get_agent`               | Get agent details by ID                                                     |
| `update_agent`            | Update only the requested agent fields across the supported backends        |
| `get_hyperliquid_balance` | Get USDC balance of a Hyperliquid master wallet                             |

### Backtesting

| Tool                  | Description                           |
| --------------------- | ------------------------------------- |
| `create_backtest`     | Submit a backtest job; if the user mentions a timezone, OpenClaw should resolve it before calling the tool, otherwise naive dates/times fall back to the OpenClaw runtime timezone, then UTC |
| `get_backtests`       | List backtests for an agent           |
| `get_backtest_status` | Check backtest job status (batch)     |
| `get_backtest_job`    | Poll backtest job progress and status |
| `get_backtest_result` | Get completed backtest results        |

## Skills

| Skill                | Description                              |
| -------------------- | ---------------------------------------- |
| `trade`              | Guided workflow for creating new paper or live agents |
| `copy-trade`         | Guided workflow for creating live copied agents from an existing source agent |
| `manage-agents`      | Guided workflow for listing, updating, and deleting agents |
| `manage-wallets`     | Guided workflow for listing and deleting wallets |
| `backtest`           | Guided workflow for running backtests    |
| `strategy-reference` | Loads the canonical trading strategy reference from `skills/strategy-reference/strategy.md` |
| `nostr-identity`     | Retrieve user's Nostr identity           |
