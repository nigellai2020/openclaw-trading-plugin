---
name: manage-wallets
description: List or delete wallets. Use when the user wants to see their wallets, remove a wallet, or manage wallet registrations.
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
