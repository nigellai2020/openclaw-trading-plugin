# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An OpenClaw plugin for trading data, paper/live trading (Hyperliquid), copy-trading, and backtesting. Registers 27 tools and 7 skills. Uses Nostr cryptography for auth and communicates with 5 backend services.

## Commands

- **Type-check:** `npx tsc --noEmit`
- **Install deps:** `npm install`
- **Install plugin locally:** `openclaw plugins install -l ./trading-plugin`
- **Restart after changes:** `openclaw gateway restart`

## Architecture

Modular OpenClaw plugin keeping `src/tools.ts` as the public entrypoint and moving schemas, shared helpers, and tool registration logic into dedicated folders. Tools are registered via `api.registerTool()` with `@sinclair/typebox` schemas for parameters. Uses native `fetch` for HTTP calls.

### Key patterns

- **Auth**: Nostr signing via `@scom/scom-signer` — generates Bearer tokens as `publicKey:signature`
- **Composite tools**: `init_trading_session`, `request_hyperliquid_setup_flow`, `deploy_agent`, and `deploy_copy_agent` orchestrate multiple API calls or user interactions into single tool invocations
- **Config loading**: Plugin config from `openclaw.plugin.json` → user config override → hardcoded defaults
- **Responses**: Unified via `textResult()` wrapping data as JSON text content
- **Debug logging**: Writes to `~/.openclaw/logs/trading-debug.json` (non-blocking)

### Backend services

| Config key             | Purpose                     |
| ---------------------- | --------------------------- |
| `baseUrl`              | Market data & agent APIs    |
| `tradingBotUrl`        | Trading bot notifications   |
| `walletAgentUrl`       | TEE wallet storage          |
| `settlementEngineUrl`  | Trader registration         |

### File structure

```
src/tools.ts                 — OpenClaw entrypoint
src/tools/register-tools.ts  — Tool and service registrations
src/context/                 — Shared runtime context for registrations
src/schemas/                 — TypeBox schemas
src/types/                   — Shared internal types
src/utils/                   — Extracted helper functions
skills/                      — 7 skill definitions (trade, copy-trade, manage-agents, manage-wallets, backtest, strategy-reference, nostr-identity)
scripts/                     — Helper scripts (generate-agent-wallet, test-live-trading, create-ema-agent)
openclaw.plugin.json         — Plugin config schema
```
