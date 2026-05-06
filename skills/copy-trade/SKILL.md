---
name: copy-trade
description: Create a copy-trading agent (paper or live) from an existing public source agent. Use when the user wants to copy an agent, follow an agent, duplicate an agent, or says things like "copy Agent 3321". Supports all four scenarios: paper→paper, live→live, paper→live, and live→paper.
---

# Copy-Trade Agent Creation

Supports all four scenarios — the copied agent can have a **different mode** and even a **different chain** from the source:
- **paper→paper**: copy a paper agent as paper (no wallet needed)
- **live→live**: copy a live agent as live (wallet required)
- **paper→live**: copy a paper agent as live (wallet required)
- **live→paper**: copy a live agent as paper (no wallet needed)

If the user has not stated a mode preference, the copy defaults to the source agent's mode.

The source agent must be a **public** agent.

## Step 1 — Initialize session
Call `init_trading_session` with `mode: "live"` to initialize keys and pre-load any wallets on file.

Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created. Do not display the private key or nsec unless asked.
- Save any returned wallets for wallet selection (needed if effective mode is live).

## Step 2 — Identify the source agent and determine effective mode

If the user already provided a source agent ID, use it. Otherwise ask for it.

Call `prepare_copy_agent` with `sourceAgentId` (and `mode` if the user already stated a preference).

Handle the response:
- If the result contains `error`, STOP and explain it.
- Determine the **effective mode**:
  - If the user stated a mode preference → use that.
  - Otherwise → use `sourceAgent.mode`.
- Use `sourceAgent.name`, `sourceAgent.marketType`, `defaults.symbol`, `defaults.chainId` as the copy defaults.
- Use the billing preflight returned by `prepare_copy_agent`:
  - If `billing.required = false`, say no upfront billing setup is required.
  - If `billing.required = true`, present the returned billing, NFT, fee, gas, subscription, and funding details before deployment, following the same style used in the normal `trade` flow.
  - Always show the full billing wallet address from `billingWallet.address` on its own line. Never truncate or abbreviate it.
  - Always show the full vault address from `billingWallet.vaultAddress` when mentioning vault approval or deposit.
  - If `fees.oswapShortfall > 0`, tell the user to deposit BNB into the billing wallet, not OSWAP by default. State the amount to top up as `billingFundingHint.amountToDeposit` BNB, and explain that OpenClaw will swap part of that BNB into OSWAP and use the rest for gas.
  - If `fees.oswapShortfall = 0` and `funding.bnbShortfall > 0`, tell the user they already have enough OSWAP and only need to top up BNB for gas.
  - If both shortfalls are zero, say the billing wallet is already funded and ask for confirmation directly.
- Do **not** ask the user for market type or strategy.

## Step 3 — Wallet selection (live mode only)

**Skip this step entirely if the effective mode is paper.**

### Resolve the chain
- If `defaults.chainId` is available and the user hasn't requested a different chain, use it.
- Otherwise ask the user which network to use. For Hyperliquid:
  - `testnet` → `998`
  - `mainnet` → `999`

### Resolve the wallet
Filter the wallets from Step 1 to those on the resolved network.

If wallets exist on that network:
- Present them and ask which one to use. Never use a markdown table. Never abbreviate `0x...` values. Show `walletAddress` and `masterWalletAddress` as full monospace lines.
- Save `walletId`, `walletAddress`, and `masterWalletAddress`.

If no wallet exists on the resolved network:
- Ask whether the user already has a Hyperliquid API wallet private key for that network.
- If yes: ask for the API wallet private key and master wallet address.
- If no: guide them to create a Hyperliquid API wallet on that network, then ask for the API wallet private key and master wallet address.
- Call `setup_live_wallet` with `ethAgentPrivateKey`, `masterWalletAddress`, and the resolved `network`.
- If `teeStorage.ok = false` or `registration.ok = false`, STOP and explain it.
- Save `registration.walletId`, `registration.walletAddress`, and `masterWalletAddress`.

After the wallet is known, call `prepare_copy_agent` again with:
- `sourceAgentId`
- `mode` (effective mode)
- `walletId`
- optional `walletAddress`
- optional `chainId` if overriding

Use this second preflight to refresh the defaults before confirmation:
- `defaults.buyLimit` should now reflect the normal live-agent formula from the selected wallet balance.
- `defaults.initialCapital` should reflect the selected wallet's USDC balance.
- `defaults.leverage` should reflect the default live leverage used for the calculation.

## Step 4 — Ask only for copy-specific overrides

Ask only for values that can differ from the source copy defaults:
- optional alias
- optional `chainId` override (only if user wants a different chain than the source)
- **Live mode only**: optional `buyLimit` override
- **Paper mode only**: optional `initialCapital` override
- optional `order` override if the user explicitly wants a different copied order size/mode

Do **not** ask for market type, strategy, or network unless required by the above.

## Step 5 — Confirm before creating

Present a summary:
- source agent ID and name
- source agent mode
- **effective mode** for the new copy (highlight if different from source)
- pair / symbol
- market type
- **Live only**: derived network and `chainId`, selected wallet and master wallet, default live capital from wallet, default leverage, buy limit
- **Paper only**: initial capital (if overridden)
- optional alias
- optional chainId override
- optional order override
- whether upfront billing setup is required

When showing the selected wallet or master wallet, never use a table or ellipsis. Show full monospace addresses on their own lines.
When showing the billing wallet, never use a table or ellipsis. Show the full address on its own line.

If billing is required and funding is still needed, follow this format instead of an ambiguous checklist:

- State clearly whether the user must top up **BNB** or can proceed with existing balances.
- If `fees.oswapShortfall > 0`, say: the billing wallet currently has insufficient OSWAP, so the user should deposit approximately `billingFundingHint.amountToDeposit` BNB to the billing wallet. Mention that OpenClaw will convert part of it into OSWAP automatically.
- If `fees.oswapShortfall = 0`, say existing OSWAP covers the billing amount and mention only the required BNB gas top-up if any.
- Show these full copyable lines:
  - `Billing wallet: <full billingWallet.address>`
  - `Network: <billingWallet.networkLabel>`
  - `OSWAP token: <full billingWallet.tokenAddress>`
  - `Billing vault: <full billingWallet.vaultAddress>`
- Avoid phrasing like `8 OSWAP deposit into billing vault` without first saying whether the user needs to deposit BNB or already has enough OSWAP.

Ask the user to confirm. Do not proceed until they explicitly confirm.

## Step 6 — Deploy copied agent

Call `deploy_copy_agent` with:
- `sourceAgentId`
- `mode` (effective mode — always pass this explicitly)
- optional `alias`
- optional `chainId` (if overriding the source agent's chain)
- **Live mode only**: `walletId`, `walletAddress`, `masterWalletAddress`, optional `buyLimit`
- **Paper mode only**: optional `initialCapital`
- optional `order`

Important:
- Do **not** call `prepare_agent_creation` or `deploy_agent` for copy-trade.
- Do **not** ask for market type or network unless required by the above.
- Do **not** ask for a new strategy.

Handle the response:
- **create.ok = false**: Report the error and STOP.
- **billing.required = true**: Present the billing result and any deposit or renewal details returned by the tool.
- **authorizeWallet.ok = false** *(live mode only)*: Warn that wallet authorization failed — the agent was created but the wallet link may not be active yet.
- **verify.ok = false**: Warn that post-creation verification did not fully succeed.
- Present the new agent ID, source agent ID, pair, effective mode, and any warnings returned in `result.warnings`.
