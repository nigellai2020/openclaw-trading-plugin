---
name: trade
description: Create a new paper or live trading agent, including copying an existing public agent. Use when the user wants to start trading, deploy a new trading agent, set up paper trading, trade on Hyperliquid or EVM networks, or copy/follow an existing public agent.
---

# Trading Agent Creation

Follow these steps to create a paper or live trading agent. This skill covers both **original agents** (user-defined strategy) and **copy agents** (copying an existing public agent).

**Copy-agent path:** If the user wants to copy, follow, or duplicate an existing agent, that is handled by this same skill. When in copy mode, Steps 1–4 are the same, Step 5 (Build strategy) is **skipped**, and the `copiedFromAgentId` is passed to `prepare_agent_creation` and `deploy_agent` instead of a strategy object.

**Session constraint (strict):** All plugin tool calls in this workflow (`init_trading_session`, `setup_live_wallet`, `search_public_agents`, `prepare_agent_creation`, `deploy_agent`) MUST be called directly from the current main session. Do NOT spawn a subagent for any step in this workflow. Do NOT use `exec`, custom scripts, or direct HTTP calls to the backend as a workaround. If a required tool is unavailable in the current tool list, stop and report a plugin or configuration issue instead of delegating.

**No-fabrication rule (strict):** Do not invent, auto-fill, or infer values the user did not provide. Keep optional fields omitted. If a required field is missing or ambiguous, ask the user a direct follow-up question before calling tools.

**No-improvisation rule (strict):** If the requested strategy pattern, operator, indicator output, or condition shape is not supported by the schema or documented in the `strategy-reference` skill, stop and tell the user it is not supported. Do not combine fields from different condition shapes, invent operator or field names, or substitute a "close enough" shape to make the request fit. Propose the closest supported alternative (e.g. the two-bar lookback pattern for "indicator crosses a numeric threshold") or ask the user how to proceed.

For copy-agent requests, pass only what the user explicitly provided plus `copiedFromAgentId`. Do not fabricate `chainId`, `marketType`, `symbol`, `leverage`, `initialCapital`, or `isPrivate`.

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
- Copy-agent exception: when `copiedFromAgentId` is provided and required fields are missing, ask follow-up questions instead of auto-filling.

## Step 2 — Initialize session
Call `init_trading_session` with the chosen `mode`.

Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created. Do not display the private key or nsec unless asked.
- **If live + wallets.wallets has entries**: Filter to the chosen network first, then present the active wallets (name, walletAddress, masterWalletAddress, network). Never use a markdown table. Never abbreviate `0x...` values. Show `walletAddress` and `masterWalletAddress` as full monospace lines. Ask which wallet to reuse. Save the chosen `walletAddress` and `masterWalletAddress`, then continue to Step 5.
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
- **registration.ok = false**: Report the exact backend error text and STOP.
  - Do not infer causes from status codes (for example, do not say `422` "usually means already registered").
  - Do not suggest deleting any wallet unless the backend message explicitly says the same wallet already exists.
- Save `teeStorage.agentWalletAddress` and `registration.walletAddress`.
- For agent deployment payloads, map wallet values into:
  - `walletAddress` = agent/API wallet address (preferred single live wallet selector)
  - `settlementConfig.ethAddress` = master wallet address
  - `settlementConfig.agentAddress` = agent/API wallet address

## Step 5 — Build strategy _(skip for copy agents)_

**Copy-agent path:** If the user is copying an existing agent, skip this entire step. Ask for the source agent ID. If the user only knows the agent name, call `search_public_agents` directly from this session, present the matches, and keep the rest of the workflow in this same session. Record the chosen source as `copiedFromAgentId`.

**Original-agent path:** Ask the user for an agent name if they have not already provided one.

Ask the user what trading strategy they want. Construct a strategy object with:
- **indicators**: technical indicators with type, name, period, timeframe, and params
- **rules**: entry (intent:"open") and exit (intent:"close") rules with conditions and order specs
- **risk_manager**: stop_loss, take_profit, trailing_stop, cooldown, per_bar_limits

**You MUST consult the `strategy-reference` skill content in the current session context before constructing any rule** that involves crossings (`crosses_above`/`crosses_below`), multi-value indicators (e.g. `macd.signal`, `bb.upper`, `linreg.slope`), discrete-value outputs (e.g. SuperTrend `.direction`, Parabolic SAR `.direction`), indicator-vs-numeric-threshold comparisons, lookback (`[n]`), or expression-based conditions. Do NOT spawn a subagent or delegate plugin tool calls to retrieve that reference. If the reference content is unavailable, stop and report that the strategy reference context is missing. Skipping it leads to malformed rule shapes that the backend rejects with "data did not match any variant of untagged enum When".

If the user says something general like "EMA crossover", ask a concise clarification question first (for example timeframe, entry/exit logic, and risk settings) before constructing the strategy.

Only build a strategy after the user confirms the missing details. Example format for EMA 20/50 crossover on M15:
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

For live perp agents, ask the user for leverage if they did not provide it. Do not default leverage.

## Step 6 — Determine initial capital
- Paper mode: ask the user for `initialCapital`.
- Live mode: do not ask for or pass `initialCapital`. The server derives it from the live wallet balance.
- If the user asks to set `initialCapital` for a live agent, explain that live-mode `initialCapital` is not accepted and is derived automatically from wallet context.
- Do not assume or auto-fetch initial capital in the plugin.

## Step 7 — Run billing preflight
- Explain that OpenClaw uses the configured `nostrPrivateKey` as the BSC/Ethereum signing key for any required NFT checks, OSWAP funding, vault credit deposit, and billing auth.
- Explain that `prepare_agent_creation` automatically registers the derived billing wallet through `POST /api/auth/login` before billing checks.
- Explain that the plugin loads all active NFT configs from `/api/nft-config` and only uses the cheapest eligible NFT when a new mint is required.
- `prepare_agent_creation` is a **read-only preflight**. It does **not** authorize deployment. After calling it, your next message must present the summary and ask for confirmation. Do **not** call `deploy_agent` in the same turn as the preflight.
- Call `prepare_agent_creation` directly from this session as a tool call. Do NOT delegate this step to a subagent or workaround via `exec` or direct HTTP requests. If the tool is unavailable, stop immediately and report a plugin or configuration problem.
- Call `prepare_agent_creation` with:
  - Paper original: `name`, `mode: "paper"`, chosen `marketType`, and `symbol`
  - Live original: `name`, `mode: "live"`, chosen `marketType`, and `symbol`
  - Copy agent: `name`, `mode`, and `copiedFromAgentId` — do **not** pass `marketType`, `symbol`, `chainId`, `leverage`, `initialCapital`, or `isPrivate` unless the user explicitly requests an override that is valid for the chosen mode
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
- *Initial Capital:* {for paper: `${initialCapital} {quote currency}`; for live: `Derived from wallet balance at creation time`}
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
- Do **not** append literal notes like `(strategy fee is 0, not shown)`.
- Keep the fee line clean and retail-friendly: include only the non-zero components.
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

**IMPORTANT:** Once the fee breakdown and shortfall are presented, immediately show the billing wallet address in the "Where to deposit" section. **Always display the full billing wallet address (never abbreviated) whenever there are upfront costs for the user to pay.** This ensures the user knows exactly where to send funds.

## Where to deposit

Use this exact structure when `fees.oswapShortfall > 0` (user needs OSWAP and it will be obtained via BNB swap):

```
**What you need to do:** Send only the missing *~{funding.bnbShortfall} BNB* to the address below. Do not send the full *~{funding.totalBnbNeeded} BNB* unless the wallet is empty. After this top-up, the wallet will have enough BNB in total. The system will then automatically use ~{funding.bnbForSwapMax} BNB to buy {fees.requiredOswap} OSWAP for billing, and keep ~{funding.bnbForGas} BNB for gas.

- Deposit network: {wallet.networkLabel}
- Send BNB to: `{wallet.address}`
```

Do NOT say "you need OSWAP" as an action item. The user's only action is to send BNB. Mention OSWAP only to explain what the BNB will be used for.

If deposit network is BNB Chain Testnet, add: `Need testnet BNB? Use the faucet: https://www.bnbchain.org/en/testnet-faucet`

## Fund your wallet

**MANDATORY - Always display billing wallet address:** When presenting any costs or funding instructions, the billing wallet address must be clearly shown in full (never abbreviated with `0x...`). This is critical for user safety and preventing funds from going to the wrong address.

**MANDATORY - Default to BNB-only deposit when user needs OSWAP:** When `fees.oswapShortfall > 0` (user doesn't have enough OSWAP), do NOT ask the user to deposit OSWAP directly. The user's one and only action is to send BNB. The system handles the swap automatically. Follow this exact wording pattern:

> Send only the missing *~{funding.bnbShortfall} BNB* to the address below. Do not ask the user to send the full *~{funding.totalBnbNeeded} BNB* unless the wallet currently has zero BNB. The system will automatically swap *~{funding.bnbForSwapMax} BNB* into *{fees.requiredOswap} OSWAP* for your billing, and use *~{funding.bnbForGas} BNB* for gas.
>
> **Deposit network:** {wallet.networkLabel}
> **Send BNB to:** `{wallet.address}`

Never write a sentence like "You need X OSWAP for billing (obtained by swapping BNB) and ~Y BNB total." — this is confusing because it implies the user must source OSWAP themselves. Also never tell the user to send the full `funding.totalBnbNeeded` when `funding.bnbShortfall` is smaller. The deposit instruction must use the missing top-up amount, not the total requirement.

> If the user already has OSWAP and prefers to send it directly, they can send *{fees.requiredOswap} OSWAP* + *~{funding.bnbForGas} BNB* for gas. Offer this as an optional note only, not the primary instruction.

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
  - Never add meta wording about omitted zero-fee components in parentheses. Just show the clean non-zero fee equation.
  - **If `fees.oswapShortfall > 0`**: The user's ONLY action is to send BNB. Use the missing top-up amount: `funding.bnbShortfall`, not `funding.totalBnbNeeded`, unless the wallet currently has zero BNB and the two values are the same. Use this exact pattern: "Send only ~{funding.bnbShortfall} BNB to `{wallet.address}`. The system will automatically swap ~{funding.bnbForSwapMax} BNB into {fees.requiredOswap} OSWAP for billing and use ~{funding.bnbForGas} BNB for gas." Do NOT write a sentence like "You need X OSWAP ... and Y BNB total" — that confuses the user into thinking they must source OSWAP separately. Do NOT show a separate "Deposit OSWAP to" address. Optionally note the manual OSWAP path as a secondary aside only.
  - **If `fees.oswapShortfall = 0`**: The user already has enough OSWAP — show only the gas BNB needed. Say existing OSWAP covers the requirement. Do not show a swap option.
  - If `funding.bnbShortfall = 0`, say wallet is already funded and skip the "Fund your wallet" and "Funding details" sections. Go straight to asking for confirmation.
  - If `fees.requiredOswap = 0` and `funding.totalBnbNeeded = 0`, skip the funding sections entirely. Show a concise summary instead: existing eligible NFT, existing billing credit covers the first period, no upfront payment needed, remind about `subscription.renewalAmount` OSWAP by `subscription.estimatedEndTime` for auto renewal. Ask the user to confirm.
  - Include "Initial Capital" whenever it is part of the confirmed request. For live agents, label it as server-derived rather than user-supplied.
  - Do not show raw chain IDs in user-facing summaries unless the user explicitly requests technical details.

Ask the user to confirm or say "Done" after funding. Do NOT proceed until they explicitly confirm.
Confirmation rules:
  - The user's original request to "create" the agent does **not** count as post-checkout confirmation.
  - You must ask a direct confirmation question after the checkout is shown.
  - Only proceed on an explicit reply such as `confirm`, `yes, create it`, `proceed`, or `done` after funding.
  - If the user asks a question about the billing amounts, answer it first and ask for confirmation again.
  - If `deploy_agent` was called too early and returns a funding shortfall, explain the breakdown, acknowledge that deployment should have waited for confirmation, and return to the confirmation step instead of behaving as if the user had already approved.

## Step 9 — Deploy agent
Call `deploy_agent` directly from this session as a tool call. Do NOT delegate this step to a subagent or workaround via `exec` or direct HTTP requests. If the tool is unavailable, stop immediately and report a plugin or configuration problem.

Call `deploy_agent` with:
- `name`, `mode`, `marketType`
- `assetType`: always pass `"crypto"` or `"stocks"`
- `chainId`: **required when `assetType` is `"crypto"`** — pass for both paper and live modes
- `symbol`: always pass when known
- **Original agent:** also pass `strategy`; if perp: `leverage` (same as `strategy.risk_manager.leverage`)
- **Copy agent:** pass `copiedFromAgentId` instead of `strategy` — do **not** pass a `strategy` object or `isPrivate`. Keep other optional fields omitted unless the user explicitly asked to override them.

If required deploy inputs are missing, ask the user for the missing fields and wait. Do not guess.
- Paper: `initialCapital`
- Live: pass `settlementConfig` with:
  - Prefer `walletAddress` when the user gives a single live wallet address (master or agent wallet registered in oswap_wallets).
  - Or pass `settlementConfig` with:
  - `ethAddress` (master wallet, required)
  - `agentAddress` (agent/API wallet, optional but recommended)
  - Never pass both `walletAddress` and `settlementConfig` in the same request.
  Do not pass `initialCapital`; it is derived server-side.

Copy-agent payload minimums:
- Preferred minimal payload: `name`, `copiedFromAgentId`, optional `mode` if user specified.
- Only include `marketType`, `symbol`, `chainId`, or `leverage` when the user explicitly asked to override source-agent defaults.
- Only include `initialCapital` when the user explicitly requested a paper-mode override.

Important:
- Do **not** pass `simulationConfig` — it is not in the API spec.
- Do **not** pass `protocol` — not in the API spec.
- Do **not** pass `buyLimit` — live sizing is derived server-side.
- Do **not** omit `chainId` for crypto original-agent flows, even in paper mode.
- For copy-agent flows, omit `chainId` unless the user explicitly asked for an override.

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
