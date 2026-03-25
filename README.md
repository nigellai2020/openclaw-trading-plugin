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

### Identity & Access

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get_nostr_identity`     | Retrieve user's Nostr npub and public key        |
| `request_trading_access` | Request trading access (requires admin approval) |

### Session & Agent Management

| Tool                    | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| `init_trading_session`  | Initialize session: check keys, verify access, optionally list wallets          |
| `setup_live_wallet`     | Store agent wallet key in TEE and register in backend                           |
| `deploy_agent`          | Create agent, notify bot, register trader (live), log action, verify            |
| `get_agent`             | Get agent details by ID                                                         |
| `get_hyperliquid_balance` | Get USDC balance of a Hyperliquid master wallet                               |

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
| `trade`              | Guided workflow for creating agents      |
| `backtest`           | Guided workflow for running backtests    |
| `strategy-reference` | Complete trading strategy schema reference |
| `nostr-identity`     | Retrieve user's Nostr identity           |
