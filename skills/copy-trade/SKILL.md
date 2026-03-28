---
name: copy-trade
description: Create a live copy-trading agent from an existing source agent. Use when the user wants to copy an agent, follow an agent, duplicate an agent, or says things like "copy Agent 3321".
---

# Copy-Trade Agent Creation

Follow these steps to create a live copy-trading agent from an existing source agent.

## Step 1 — Initialize live session
Call `init_trading_session` with mode `"live"`.

Handle the response:
- **keys.generated = true**: Inform the user a new Nostr identity was created. Do not display the private key or nsec unless asked.
- Save any returned wallets for selection after the source agent preflight.

## Step 2 — Identify the source agent
If the user already provided a source agent ID, use it. Otherwise ask for the source agent ID.

Call `prepare_copy_agent` with `sourceAgentId`.

Handle the response:
- If the result contains `error`, STOP and explain it.
- Use `sourceAgent.name`, `sourceAgent.mode`, `sourceAgent.marketType`, `defaults.symbol`, `defaults.buyLimit`, and `defaults.chainId` as the copy defaults.
- Use the billing preflight returned by `prepare_copy_agent`:
  - If `billing.required = false`, say no upfront billing setup is required.
  - If `billing.required = true`, present the returned billing, NFT, fee, gas, and funding details before deployment, following the same style used in the normal `trade` flow.
- Do **not** ask the user for market type.
- If `sourceAgent.mode = "paper"` or `defaults.chainId` is missing, ask the user which live Hyperliquid network to use:
  - `testnet`
  - `mainnet`
- Derive live `chainId` from that user choice:
  - `testnet` -> `998`
  - `mainnet` -> `999`
- Only skip the network question when the source agent already implies it through `defaults.chainId`.
- Do **not** ask the user to build a new strategy.

## Step 3 — Resolve the wallet on the derived or chosen network
If `init_trading_session` returned wallets:
- Filter to wallets on the derived network, or the user-chosen network if the source agent is paper / missing chain.
- If wallets exist on that network, present them and ask which one to use.
- Save `walletId`, `walletAddress`, and `masterWalletAddress`.

If no wallet exists on the derived network:
- Ask whether the user already has a Hyperliquid API wallet private key for that network.
- If yes: ask for the API wallet private key and master wallet address.
- If no: guide them to create a Hyperliquid API wallet on that derived network, then ask for the API wallet private key and master wallet address.
- Call `setup_live_wallet` with `ethAgentPrivateKey`, `masterWalletAddress`, and the derived `network`.
- If `teeStorage.ok = false` or `registration.ok = false`, STOP and explain it.
- Save `registration.walletId`, `registration.walletAddress`, and `masterWalletAddress`.

After the wallet is known, call `prepare_copy_agent` again with:
- `sourceAgentId`
- `walletId`
- optional `walletAddress`

Use this second preflight to refresh the defaults before confirmation:
- `defaults.buyLimit` should now reflect the normal live-agent formula from the selected wallet balance
- `defaults.initialCapital` should reflect the selected wallet's USDC balance
- `defaults.leverage` should reflect the default live leverage used for the calculation

## Step 4 — Ask only for copy-specific overrides
Ask only for values that can differ from the source copy defaults:
- optional alias
- optional `buyLimit` override
- optional `order` override if the user explicitly wants a different copied order size/mode

## Step 5 — Confirm before creating
Present a summary:
- source agent ID and name
- source agent mode
- pair / symbol
- market type
- derived network and `chainId`
- selected wallet and master wallet
- default live capital from wallet
- default leverage used for buy-limit calculation
- buy limit
- optional alias
- optional order override
- whether upfront billing setup is required

Ask the user to confirm. Do not proceed until they explicitly confirm.

## Step 6 — Deploy copied live agent
Call `deploy_copy_agent` with:
- `sourceAgentId`
- `walletId`
- `walletAddress`
- `masterWalletAddress`
- optional `alias`
- optional `buyLimit`
- optional `order`

Important:
- Do **not** call `prepare_agent_creation` or `deploy_agent` for copy-trade.
- Do **not** ask for market type or network unless the source agent is missing them and the tool explicitly requires clarification.
- Do **not** ask for a new strategy.

Handle the response:
- **create.ok = false**: Report the error and STOP.
- **billing.required = true**: Present the billing result and any deposit or renewal details returned by the tool.
- **notify.ok = false**: Warn but continue.
- **authorizeWallet.ok = false**: Warn that wallet authorization failed.
- **registerTrader.ok = false**: Warn that settlement registration failed and the copied agent may not trade yet.
- **verify.ok = false**: Warn that verification did not fully succeed.
- Present the new agent ID, source agent ID, pair, and any warnings returned by the tool.
