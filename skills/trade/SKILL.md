---
name: trade
description: Create a paper or live trading agent. Use when the user wants to start trading, deploy a trading agent, set up paper trading, or trade on Hyperliquid.
---

# Trading Agent Creation

Follow these steps to create a paper or live trading agent.

## Step 1 — Ask trading mode and resolve market/network
Ask the user: **paper** or **live** mode?
- Paper: simulated trading, no real funds
- Live: real trading on Hyperliquid (testnet or mainnet)

Then resolve the missing choices before continuing:
- If the user did not already specify a market type, ask: **spot** or **perp**?
- If **live** and the user did not already specify a network, ask: **testnet** or **mainnet**?
- Derive live `chainId` from the chosen network:
  - testnet → `998`
  - mainnet → `999`
- Do not ask again if the user already gave the market type or live network in their original request.

## Step 2 — Initialize session
Call `init_trading_session` with the chosen `mode`.

Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created. Do not display the private key or nsec unless asked.
- **access.hasAccess = false**: Do not stop. Tell the user they are not whitelisted, so agent creation will need the BSC billing flow: eligible NFT check, OSWAP funding, vault credit deposit, then agent creation.
- **If live + wallets.wallets has entries**: Filter to the chosen network first, then present the active wallets (name, walletAddress, masterWalletAddress, network). Ask which to reuse. Save the chosen `walletId`, `walletAddress`, and `masterWalletAddress`, then continue to Step 5.
- **If live + no wallets on the chosen network**: Continue to Step 3.
- **If paper**: Skip to Step 5.

Important:
- `init_trading_session` may return early when `access.hasAccess = false`, so for live mode you may need to call `list_wallets` separately before deciding whether to reuse an existing wallet.

## Step 3 (live only) — Create API wallet on Hyperliquid
Ask the user if they already have a Hyperliquid API wallet private key.
- If yes: ask for the private key and their master wallet address (0x...), proceed to Step 4.
- If no: guide them:
  1. Go to Hyperliquid (testnet: app.hyperliquid-testnet.xyz, mainnet: app.hyperliquid.xyz)
  2. Connect their master wallet
  3. Click **More** > **API** (or visit the /API page)
  4. Click **Create API Wallet**, enter a name, click **Generate**
  5. **Copy the private key immediately** (shown only once)
  6. Set validity to MAX (180 days), click **Authorize**, sign the message

Then ask for: (1) the API wallet private key, (2) their master wallet address (0x...).

## Step 4 (live only) — Store and register wallet
Call `setup_live_wallet` with `ethAgentPrivateKey`, `masterWalletAddress`, and `network`.

Handle the response:
- **teeStorage.ok = false**: Report the error and STOP.
- **registration.ok = false**: Report the error and STOP.
- Save `teeStorage.agentWalletAddress`, `registration.walletId`, and `registration.walletAddress`.

## Step 5 — Build strategy
Ask the user for an agent name if they have not already provided one.

Ask the user what trading strategy they want. Construct a strategy object with:
- **indicators**: technical indicators with type, name, period, timeframe, and params
- **rules**: entry (intent:"open") and exit (intent:"close") rules with conditions and order specs
- **risk_manager**: stop_loss, take_profit, trailing_stop, cooldown, per_bar_limits

For detailed schema references, see the `strategy-reference` skill.

If the user says something general like "EMA crossover", construct a reasonable default. Example for EMA 20/50 crossover on M15:
```json
{
  "name": "ema_crossover",
  "symbol": "ETH/USDC",
  "indicators": [
    {"type":"ema","name":"ema_20_M15","period":20,"timeframe":"M15"},
    {"type":"ema","name":"ema_50_M15","period":50,"timeframe":"M15"}
  ],
  "rules": [
    {"id":"open_long","intent":"open","when":{"indicator":"ema_20_M15","op":"crosses_above","other":"ema_50_M15"},"order":{"type":"market","side":"long","size":{"mode":"all"}}},
    {"id":"close_long","intent":"close","when":{"indicator":"ema_20_M15","op":"crosses_below","other":"ema_50_M15"},"order":{"type":"market","size":{"mode":"all"}}}
  ],
  "risk_manager":{"stop_loss":{"enabled":true,"mode":"percent","value":5},"take_profit":{"enabled":true,"mode":"percent","value":10},"cooldown":{"entry_secs":60}}
}
```

If live: leverage defaults to 3x. **Do NOT ask the user for leverage** unless they explicitly specify a different value. Set `strategy.risk_manager.leverage` accordingly.

## Step 6 — Determine initial capital
- **Live**: `deploy_agent` auto-fetches the wallet balance as initial capital. **Do NOT ask the user for initial capital in live mode.** Do NOT call `get_hyperliquid_balance` separately — the deploy step handles it.
- **Paper**: Ask the user for their desired initial capital.

## Step 7 — Run billing preflight for non-whitelisted users
If `access.hasAccess = false`:
- Explain that OpenClaw uses the configured `nostrPrivateKey` as the BSC/Ethereum signing key for NFT checks, OSWAP funding, vault credit deposit, and billing auth.
- Explain that `prepare_agent_creation` automatically registers the derived billing wallet through `POST /api/auth/login` before billing checks.
- Explain that the plugin loads all active NFT configs from `/api/nft-config` and only uses the cheapest eligible NFT when a new mint is required.
- Call `prepare_agent_creation` with:
  - Paper: `name`, `mode: "paper"`, chosen `marketType`, and `symbol`
  - Live: `name`, `mode: "live"`, chosen `marketType`, and `symbol`
- Present the returned plan clearly:
  - whether an NFT mint is needed
  - how much OSWAP is required
  - how much BNB is required for swap + gas
  - what approvals will happen
  - how much goes into the vault
  - that the vault deposit becomes billable credit, not a one-time burn
- If `prepare_agent_creation` reports an `error`, STOP and explain it.

If `access.hasAccess = true`, skip this step.

## Step 8 — Confirm before creating
Present a summary:
- Agent name, trading pair, strategy name
- Indicators, entry/exit rules, risk settings
- Initial capital
- If paper: market type
- If live: network, `chainId`, master wallet, agent wallet, leverage
- If not whitelisted: include the `prepare_agent_creation` billing summary

Ask the user to confirm. Do NOT proceed until they explicitly confirm.

## Step 9 — Deploy agent
Call `deploy_agent` with:
- `name`, `strategy`, `mode`
- Paper: `initialCapital`, `marketType` (spot/perp), `simulationConfig` — defaults: spot → `{"asset_type":"crypto","protocol":"uniswap","chain_id":1}`, perp → `{"asset_type":"crypto","protocol":"hyperliquid","chain_id":998}`, stocks → `{"asset_type":"stocks"}`
- If perp: `leverage` (same as `strategy.risk_manager.leverage`)
- Live: chosen `marketType`, `leverage`, `walletId`, `walletAddress`, `masterWalletAddress`, `symbol`, `protocol: "hyperliquid"`, and the derived live `chainId` (do NOT pass `initialCapital` — it is auto-fetched from wallet balance)

Important:
- Do **not** pass top-level `chainId` for paper mode.
- Do **not** rely on a default live `chainId`; always pass the derived value from the user’s chosen network.

Handle the response:
- **create.ok = false**: Report error and STOP.
- **billing.required = true**: Present the billing execution result:
  - NFT minted or existing NFT verified
  - vault deposit amount and updated vault credit
  - fee breakdown
  - next billing date estimate
- **notify.ok = false**: Warn but continue.
- **registerTrader.ok = false** (live): Warn that settlement registration failed — agent may not trade.
- Present: agent ID, name, pair, capital, and `create.agentUrl`.
