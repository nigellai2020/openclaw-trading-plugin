---
name: backtest-leader-board
description: Show the backtest leaderboard ranking top-performing agents by return percentage. Use when the user asks about best agents, top performers, backtest rankings, or leaderboard by period (daily, weekly, monthly, 6-month).
---

# Backtest Leaderboard

Follow these steps to show the backtest leaderboard.

## Step 1 — Determine the period

Ask the user which period they want to see, or infer from their message:

- **daily** / **1d**: Last 24 hours backtest results
- **weekly** / **1w**: Last 7 days backtest results
- **monthly** / **1m**: Last 30 days backtest results
- **6m**: Last 6 months backtest results

If the user asks for multiple periods, call the tool once per period.

## Step 2 — Fetch the leaderboard

Call `backtest_leader_board` with the chosen `period` and optional `limit` (default 10).

If the response contains no data, inform the user that no completed backtests are available for that period yet.

## Step 3 — Present results

Format the leaderboard as a table with columns: Rank, Agent Name, Symbol, Return %, Max Drawdown, Win Rate, PnL.

- Show `return_pct` and `max_drawdown` as percentages with 2 decimal places.
- Show `win_rate` as a percentage if available, otherwise show "N/A".
- Show `pnl` as USD with 2 decimal places.
- Sort is already by return % descending from the API.
