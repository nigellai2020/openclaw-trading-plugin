---
name: manage-wallets
description: List, update, or delete wallets. Use when the user wants to see their wallets, rename a wallet, change Hyperliquid wallet metadata, remove a wallet, or manage wallet registrations. For setting up new Hyperliquid API wallets, use request_hyperliquid_setup_flow to get a guided registration link.
---

# Manage Wallets

## Register a new Hyperliquid API wallet
Call `request_hyperliquid_setup_flow` to generate a secure setup link. This will return:
- A link to open the hyperliquid-management web app
- Instructions for the user to connect their master wallet, generate/import an API wallet, and register with OpenSwap
- Options to copy the link or refresh it if it expires

When presenting the result, include the setup URL verbatim unless the chat client has already rendered an open-app button in the same message. Do not refer to a "link above" unless the URL or button is visible.

If `request_hyperliquid_setup_flow` returns `telegramMessageSent: true`, the fixed Telegram message with keyboard has already been sent. Do not send an additional user-facing message.

The Refresh link button uses the plugin command `/hlrefresh testnet` or `/hlrefresh mainnet`, which bypasses the LLM. Do not ask the user to refresh with a natural-language message.

The user completes the registration flow in the web app, which handles:
- Master wallet connection
- API wallet generation or import
- Hyperliquid authorization (if needed)
- OpenSwap registration

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
