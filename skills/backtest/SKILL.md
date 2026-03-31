---
name: backtest
description: Run a backtest for a trading agent. Use when the user wants to backtest a strategy, test historical performance, or run a simulation on past data. Guides through key setup, agent selection, parameter configuration, submission, and status checking.
---

# Backtest Agent Strategy

Follow these steps to run a backtest.

## Step 1 — Initialize session
Call `init_trading_session` with mode `"paper"`. Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created.

## Step 2 — Identify the agent
If the user specified an agent ID, use it. Otherwise ask the user for the agent ID. Call `get_agent` to fetch the agent details (name, strategy, capital).

## Step 3 — Set backtest parameters
Ask the user for:
- **Time range**: start and end time
  - If the user does **not** specify a time range, default to a rolling 30-day window ending now. Do **not** invent a different default.
  - Do **not** expect the user to provide ISO timestamps with offsets directly.
  - Date-only values like `2026-03-20` are allowed
  - Unix timestamps are allowed
  - Do **not** ask the user for timezone separately by default.
  - If the user explicitly mentions any timezone or local-time context, such as `HK time`, `Hong Kong time`, `Toronto time`, `New York time`, `UTC`, `GMT`, or an IANA zone name, OpenClaw must resolve that timezone itself.
  - When OpenClaw resolves a user-mentioned timezone, call `create_backtest` with:
    - `startTime` and `endTime` converted into ISO datetimes with explicit offsets for that timezone
    - `timeZone` set to the resolved timezone so the tool can interpret the request consistently
  - If the user gives an explicit numeric offset in the timestamp itself, preserve it and still pass `timeZone` if the user also named the timezone separately.
  - If the user gives no timezone signal at all, pass the date/datetime as given; `create_backtest` will fall back to the OpenClaw runtime timezone, and then to `UTC` if runtime resolution fails.
  - If the user gives an ambiguous abbreviation like `EST`, `CST`, or `PST`, ask them to clarify instead of guessing.
- **Initial capital**: or default to the agent's existing capital
- **Protocol fee** (optional): fee override
- **Gas fee** (optional): fee override

## Step 4 — Optionally override strategy
If the user wants to test a different strategy, build a new one (indicators, rules, risk_manager). For detailed schema references, see the `strategy-reference` skill. Otherwise use the agent's existing strategy.

## Step 5 — Confirm before submitting
Present a summary: agent name/ID, initial capital, fees (if any), strategy (existing or override), and the resolved time interpretation.
- If the user did not provide a time range, explicitly say the default rolling 30-day window will be used and show that interpreted range.
- If the user mentioned a timezone phrase, explicitly say which timezone OpenClaw resolved, and show the interpreted local range in a human-readable format like `2026-03-20 00:00:00 (+08:00)`, not raw ISO strings.
- If the user gave explicit timezone offsets, say those exact times will be preserved.
- If the user gave naive dates/times with no timezone phrase, explicitly say OpenClaw will interpret them in the runtime timezone.
Ask the user to confirm before proceeding. Do NOT call `create_backtest` until the user explicitly confirms.

## Step 6 — Submit the backtest
Call `create_backtest` with agentId, initialCapital, optional startTime, optional endTime, optional `timeZone`, and optional protocolFee, gasFee, strategy.
- If OpenClaw resolved a timezone phrase from the user, pass offset-bearing ISO strings plus the resolved `timeZone`.
- If there was no timezone phrase, pass the user's naive value and let the tool apply runtime-timezone fallback.
- If the user did not provide a range, omit `startTime` and `endTime` so the tool applies the default rolling 30-day window.
- If the backend rejects the submission, surface that backend error directly and STOP.
- After submission, the first line must include the `jobId`. Keep the response simple: report the `jobId` and status. Do not echo technical lines like `Timezone used` or `Normalized UTC range` unless the user explicitly asks for them.

## Step 7 — Poll progress and fetch results
Call `get_backtest_job` with the jobId to poll its progress and status.
- If status is **Completed**: call `get_backtest_result` with the jobId and present a summary including portfolio value, return %, win rate, max drawdown, Sharpe ratio, and trade count.
- If still running: inform the user of the current progress, keep the initial acknowledgment tied to the `jobId`, and suggest checking again later.

## Step 8 — Show backtest history
Call `get_backtests` with the agentId to list past backtests for context.
