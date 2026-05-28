---
name: manage-wallets
description: List, update, or delete wallets. Use when the user wants to see their wallets, rename a wallet, change Hyperliquid wallet metadata, remove a wallet, or manage wallet registrations.
---

# Manage Wallets

## List wallets
Call `list_wallets`.
- Never present wallet data in a markdown table.
- Never abbreviate wallet addresses with `...`.
- Present each wallet as a flat block with full monospace addresses on their own lines:
  - ID and name
  - `walletAddress`
  - `masterWalletAddress`
  - type, network, status

## Delete a wallet
1. If the user hasn't specified a wallet address, call `list_wallets` first and ask which one to delete.
2. Check if any agents are using this wallet. If so, warn the user and ask them to delete those agents first.
3. Confirm with the user before deleting — show the wallet name and the full wallet address in monospace with no truncation.
4. Call `delete_wallet` with the `walletAddress`.
5. Report results: TEE removal and trading-data removal status.

## Update a wallet
1. If the user hasn't specified a wallet address, call `list_wallets` first and ask which wallet to update.
2. For a rename-only request, call `update_wallet` with `walletAddress` and `name`.
3. For Hyperliquid metadata changes, collect `walletAddress`, `walletType`, `masterWalletAddress`, and `hyperliquidNetwork`, then call `update_wallet`.
4. Remind the user that Hyperliquid wallet updates are revalidated against the upstream `extraAgents` API and may fail if the wallet is not currently linked to the supplied master wallet on the selected network.
5. Report whether the trading-data update succeeded and include any backend error message verbatim.
