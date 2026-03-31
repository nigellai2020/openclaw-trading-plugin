---
name: market-data
description: Get live token prices or historical price data. Use when the user asks for the current price, latest price, live price, token prices, or candle / OHLC history.
---

# Market Data

## Live prices
- For any current/latest/live price question, always call `get_token_prices`. Never answer a live price from memory.
- Before calling `get_token_prices`, normalize user-provided symbols in OpenClaw:
  - trim whitespace
  - uppercase the symbol
  - if the user gave a pair like `ETH/USDC`, strip the quote side and use the base token, e.g. `ETH`
- If the user asks for one token, call `get_token_prices` with a single-symbol `symbols` array.
- If the user asks for multiple tokens, call `get_token_prices` with all normalized symbols in `symbols`.
- If the user asks for all tracked prices, call `get_token_prices` with no `symbols`.

## Validation and retry
- Do **not** pass lowercase, whitespace-padded, or pair-form symbols directly to `get_token_prices`.
- If `get_token_prices` returns a validation error, retry only if you can deterministically normalize the user's intent into uppercase base-token symbols.
- If you still cannot determine the intended base symbol, ask the user to clarify the token symbol.
- If the tool returns `unavailableSymbols`, tell the user those symbols are unavailable instead of inventing a price.

## Historical prices
- For candle history, historical price ranges, or OHLC requests, use `get_ohlc`.
- `get_ohlc` expects a trading pair like `BTC/USDC`, not a base token symbol.
