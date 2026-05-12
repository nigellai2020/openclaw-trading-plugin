---
name: backtest-leader-board
description: Show the agent leaderboard ranking top-performing agents by backtest return percentage. Use when the user asks about leaderboard, rankings, best agents, or top performers. Supports filtering by chain, pair, mode, and market type.
---

# Backtest Leaderboard

Follow these steps to show the backtest leaderboard.

## Step 1 — Determine the lookback period

Ask the user which lookback period they want to see, or infer from their message. These are lookback windows (how far back the backtest covers):

- **daily** / **1d** — backtest over the last 1 day
- **weekly** / **1w** — backtest over the last 7 days
- **monthly** / **1m** — backtest over the last 30 days

If the user asks for multiple periods, call the tool once per period.

## Step 2 — Determine optional filters

Ask the user if they want to filter the leaderboard by:

- **Blockchain chain** — filter by specific network (e.g., Ethereum, BSC, Arbitrum). Pass the chain ID (e.g., 1 for Ethereum, 56 for BSC).
- **Trading pair** — filter by pair symbol (e.g., "ETH/USDC", "BTC/USDT"). Pass the symbol string.
- **Trading mode** — filter by live or paper trading ("live" or "paper").
- **Market type** — filter by spot or perpetual futures ("spot" or "perp").

If the user specifies any filters, include them in the tool call. Otherwise, show the global leaderboard across all filters.

## Step 3 — Fetch the leaderboard

Call `backtest_leader_board` with the chosen `period`, optional `limit` (default 10), and any filters specified in Step 2.

Each leaderboard entry includes the agent identifier as `agent_id` / `agentId`. Treat that as required output when summarizing results for the user.

If the response contains no data, inform the user that no completed backtests are available for that period/filter combination yet.

## Step 4 — Present results

Start with a title: **Agent's backtest leaderboard ({lookback_time}{filters}) with total return - top {N}** where:
- `{lookback_time}` is "1-day lookback", "7-day lookback", or "30-day lookback"
- `{filters}` shows active filters if any (e.g., " · Ethereum · ETH/USDC · Live")
- `{N}` is the number of results

Do NOT use a markdown table. For each agent, show: rank, name, symbol, and return %. Add a blank line between each agent. Keep it concise.
Always include the agent ID next to the name, for example: `#1 Agent 3027 — Trend Follower · ETH/USDC · +12.4%`.
