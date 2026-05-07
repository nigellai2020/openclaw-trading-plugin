---
name: trade
description: Create a new paper or live trading agent. Use when the user wants to start trading, deploy a new trading agent, set up paper trading, or trade on Hyperliquid or EVM networks. Do not use this skill to copy an existing agent.
---

# Trading Agent Creation

Follow these steps to create a paper or live trading agent.

If the user wants to copy, follow, or duplicate an existing agent, use the `copy-trade` skill instead of this one.

## Step 1 — Ask trading mode and resolve market/network
Ask the user: **paper** or **live** mode?
- Paper: simulated trading, no real funds
- Live: real trading on Hyperliquid or EVM networks

Then resolve the missing choices before continuing:
- If the user did not already specify a market type, ask: **spot** or **perp**?
- Ask (or infer) whether the agent trades **crypto** or **stocks** — this sets `assetType`.
  - Stocks agents do not require a `chainId`.
  - **Crypto agents require a `chainId` for both paper and live modes.**
- For crypto agents, resolve the chain:
  - For Hyperliquid: ask **testnet** or **mainnet**?
    - testnet → `chainId: 998`
    - mainnet → `chainId: 999`
  - For EVM (e.g. Ethereum, BSC, Arbitrum, Base): ask or infer the chain ID.
- Do not ask again if the user already specified the asset type, market type, or network.

## Step 2 — Initialize session
Call `init_trading_session` with the chosen `mode`.

Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created. Do not display the private key or nsec unless asked.
- **If live + wallets.wallets has entries**: Filter to the chosen network first, then present the active wallets (name, walletAddress, masterWalletAddress, network). Never use a markdown table. Never abbreviate `0x...` values. Show `walletAddress` and `masterWalletAddress` as full monospace lines. Ask which wallet to reuse. Save the chosen `walletId`, `walletAddress`, and `masterWalletAddress`, then continue to Step 5.
- **If live + no wallets on the chosen network**: Continue to Step 3.
- **If paper**: Skip to Step 5.

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
- **Live on Hyperliquid (chainId 998/999)**: `deploy_agent` auto-fetches the wallet balance as initial capital. **Do NOT ask the user for initial capital.** Do NOT call `get_hyperliquid_balance` separately.
- **Live on other networks**: `deploy_agent` cannot auto-fetch the balance. **Ask the user for their desired initial capital.**
- **Paper**: Ask the user for their desired initial capital.

## Step 7 — Run billing preflight
- Explain that OpenClaw uses the configured `nostrPrivateKey` as the BSC/Ethereum signing key for any required NFT checks, OSWAP funding, vault credit deposit, and billing auth.
- Explain that `prepare_agent_creation` automatically registers the derived billing wallet through `POST /api/auth/login` before billing checks.
- Explain that the plugin loads all active NFT configs from `/api/nft-config` and only uses the cheapest eligible NFT when a new mint is required.
- `prepare_agent_creation` is a **read-only preflight**. It does **not** authorize deployment. After calling it, your next message must present the summary and ask for confirmation. Do **not** call `deploy_agent` in the same turn as the preflight.
- Call `prepare_agent_creation` with:
  - Paper: `name`, `mode: "paper"`, chosen `marketType`, and `symbol`
  - Live: `name`, `mode: "live"`, chosen `marketType`, and `symbol`
- If `prepare_agent_creation.billing.required = false`, say no upfront billing setup is required and skip to Step 8.
- If `prepare_agent_creation.billing.required = true`, present the checkout page described below.
- If `prepare_agent_creation` reports an `error`, STOP and explain it.

## Step 8 — Confirm before creating

If `billing.required = false`, present a simple agent summary (name, pair, strategy, indicators, entry/exit rules with order size, risk settings, initial capital, mode/network details) and ask the user to confirm.
- Whenever this summary includes wallet data, never use a table or ellipsis. Show each wallet address as a full monospace line.
- In user-facing summaries, use plain network names (for example `Hyperliquid Mainnet`). Do not show raw chain IDs unless the user explicitly asks.

If `billing.required = true`, present the full checkout page below. Follow this structure and ordering closely. Populate all fields from `prepare_agent_creation` response data.

```md
### 🚀 Confirm your agent setup

Please review your agent before funding your wallet.

## Agent

*{name}*

- *Mode:* {mode}
- *Market:* {marketType}
- *Symbol:* {symbol}
- *Initial Capital:* ${initialCapital} {quote currency}
- *Trading Market:* {trading network label in plain language} {add "(simulated)" for paper}

## Strategy

*{strategy name}*

- {indicator summary, e.g. "EMA 20 (M15) + EMA 50 (M15)"}
- {entry rule with order size, e.g. "Buy when EMA 20 crosses above EMA 50 (Order size: 100% of capital)"}
- {exit rule with order size, e.g. "Close when EMA 20 crosses below EMA 50 (Order size: 100% of position)"}
- Stop-loss: {stop loss %}
- Take-profit: {take profit %}
- Cooldown: {cooldown}s

## Billing

- *{fees.firstBillingAmount} OSWAP due now* to start your first *rolling {subscription.renewalPeriodDays}-day billing period*
- This is your first billing-period charge (not a trading fee)
- Your current billing period will end on *{subscription.estimatedEndTime}*
- To keep this agent running, please make sure *{subscription.renewalAmount} OSWAP is available again by that time*
- Billing is based on *{subscription.renewalPeriodDays}-day periods*, not calendar months

## Billing breakdown

- First billing amount: *{fees.firstBillingAmount} OSWAP* = {sum of non-zero fee components only}
- If strategy fee is zero, do not show it. Example: `operating fee *{fees.operatingFee}* + protocol fee *{fees.protocolFee}*`
- Existing billing credit: *{fees.existingVaultCredit} OSWAP*
- Billing credit added for this setup: *{fees.oswapForInitialVaultCredit} OSWAP*
- NFT requirement: *{fees.oswapForNft} OSWAP* {say "(not needed; eligible NFT already found)" when zero}
- Total OSWAP required now: *{fees.requiredOswap} OSWAP*
- Current billing-wallet OSWAP shortfall: *{fees.oswapShortfall} OSWAP*
- BNB reserved for swap: *~{funding.bnbForSwapMax} BNB* {or say zero when no swap is needed}
- BNB reserved for gas: *~{funding.bnbForGas} BNB*
- Total BNB needed: *~{funding.totalBnbNeeded} BNB*
- Current BNB shortfall: *~{funding.bnbShortfall} BNB*
- Explain the shortfall in plain language. Example: "The ~0.018 BNB shortfall is made up of ~0.015 BNB to swap into OSWAP plus ~0.003 BNB for gas."

## Where to deposit

- *Deposit network:* {wallet.networkLabel}
- *Deposit BNB to:* `{wallet.address}`
- This deposit network is for billing setup and can differ from the trading market network
- If deposit network is *BNB Chain Testnet*, add: `Need testnet BNB? Use the faucet: https://www.bnbchain.org/en/testnet-faucet`

## Fund your wallet

You need:

- *{fees.requiredOswap} OSWAP* for the first billing period
- *~{funding.bnbForGas} BNB* for network fees

### Option 1 — Easiest

Send *~{funding.totalBnbNeeded} BNB* and I'll handle the swap and complete setup.

### Option 2 — Manual

Send:

- *{fees.requiredOswap} OSWAP*
- *~{funding.bnbForGas} BNB*

## Funding details

- *Deposit network:* {wallet.networkLabel}
- *Deposit BNB to:* `{wallet.address}`
- {Do not show token/vault contract addresses unless the user explicitly asks for technical details}

## Next step

After funding your wallet, reply:
*Done*
```

Render rules:
  - If `nft.hasEligibleNft = true`, do not show an NFT charge in the billing section.
  - Always show the Billing breakdown section whenever `billing.required = true`, even when some amounts are zero.
  - Use non-technical, retail-style wording in the default summary. Avoid internal terms like `billing vault`, `token address`, `chainId`, `settlement config`, and backend API names unless the user asks.
  - Explicitly state the BNB deposit network and that it may differ from the trading market network.
  - If the deposit network is BNB Chain Testnet, include testnet faucet guidance: https://www.bnbchain.org/en/testnet-faucet
  - If `fees.oswapShortfall = 0`, the user already has enough OSWAP — hide Option 1 (swap) and adjust the "You need" section to only show gas fees. Say existing OSWAP covers the requirement.
  - If `funding.bnbShortfall = 0`, say wallet is already funded and skip the "Fund your wallet" and "Funding details" sections. Go straight to asking for confirmation.
  - If `fees.requiredOswap = 0` and `funding.totalBnbNeeded = 0`, skip the funding sections entirely. Show a concise summary instead: existing eligible NFT, existing billing credit covers the first period, no upfront payment needed, remind about `subscription.renewalAmount` OSWAP by `subscription.estimatedEndTime` for auto renewal. Ask the user to confirm.
  - For live mode, omit "Initial Capital" from the Agent section (it is auto-fetched from wallet balance).
  - Do not show raw chain IDs in user-facing summaries unless the user explicitly requests technical details.

Ask the user to confirm or say "Done" after funding. Do NOT proceed until they explicitly confirm.
Confirmation rules:
  - The user's original request to "create" the agent does **not** count as post-checkout confirmation.
  - You must ask a direct confirmation question after the checkout is shown.
  - Only proceed on an explicit reply such as `confirm`, `yes, create it`, `proceed`, or `done` after funding.
  - If the user asks a question about the billing amounts, answer it first and ask for confirmation again.
  - If `deploy_agent` was called too early and returns a funding shortfall, explain the breakdown, acknowledge that deployment should have waited for confirmation, and return to the confirmation step instead of behaving as if the user had already approved.

## Step 9 — Deploy agent
Call `deploy_agent` with:
- `name`, `strategy`, `mode`, `marketType`
- `assetType`: always pass `"crypto"` or `"stocks"`
- `chainId`: **required when `assetType` is `"crypto"`** — pass for both paper and live modes
- `symbol`: always pass when known
- If perp: `leverage` (same as `strategy.risk_manager.leverage`)
- Paper: `initialCapital`
- Live: `walletAddress`, `masterWalletAddress`. For Hyperliquid (chainId 998/999), `initialCapital` is auto-fetched from the wallet balance — do NOT pass it. For other networks, pass `initialCapital` explicitly.

Important:
- Do **not** pass `simulationConfig` — it is not in the API spec.
- Do **not** pass `walletId` or `protocol` — not in the API spec.
- Do **not** omit `chainId` for crypto agents, even in paper mode.

Handle the response:
- **create.ok = false**: Report error and STOP.
- **billing.required = true**: Present a receipt-style billing result:
  - billing status: NFT minted or existing NFT verified
  - vault deposit made and updated vault credit
  - fee breakdown reused from the preflight checkout
  - next billing date estimate
  - remind the user that there should be at least `billing.result.feeBreakdown.firstBillingAmount` OSWAP in the billing wallet by `billing.result.nextBillingDateEstimate` for auto renewal
  - include any warning returned in `billing.result.warning`
- **log.ok = false**: Warn but continue (action log is non-critical).
- Present: agent ID, name, pair, capital, and `create.agentUrl`.
