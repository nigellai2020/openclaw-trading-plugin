---
name: backtest-leader-board
description: Show the backtest leaderboard ranking top-performing agents by return percentage. Use when the user asks about best agents, top performers, backtest rankings, or leaderboard by period (daily, weekly, monthly, 6-month).
---

# Backtest Leaderboard

Follow these steps to show the backtest leaderboard.

## Step 1 — Determine the period

Ask the user which period they want to see, or infer from their message:

- **daily** / **1d**
- **weekly** / **1w**
- **monthly** / **1m**

If the user asks for multiple periods, call the tool once per period.

## Step 2 — Fetch the leaderboard

Call `backtest_leader_board` with the chosen `period` and optional `limit` (default 10).

If the response contains no data, inform the user that no completed backtests are available for that period yet.

## Step 3 — Present results

Start with a title: **Agent's backtest leaderboard ({lookback_time}) with total return - top {N}** where `{lookback_time}` is "daily", "weekly", or "monthly" and `{N}` is the number of results.

Do NOT use a markdown table. For each agent, show: rank, name, symbol, and return %. Add a blank line between each agent. Keep it concise.
