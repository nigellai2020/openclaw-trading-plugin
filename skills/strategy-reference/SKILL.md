---
name: strategy-reference
description: Complete reference for strategy indicators, rules, risk management, and examples. Use when constructing a trading strategy JSON.
---

# Strategy Reference

This skill uses `strategy.md` in the same folder as the canonical strategy-config reference.

Before answering strategy questions or generating strategy JSON:

1. Read `strategy.md`.
2. Treat `strategy.md` as the full reference for indicators, rules, risk management, examples, and deprecated syntax.
3. When `strategy.md` is richer than the OpenClaw tool contract, prefer the registered tool parameter schemas and `src/schemas/strategy.ts` for the final JSON shape.
4. Prefer the plugin-friendly canonical forms in output:
   - Put indicator-specific settings under `params`.
   - Use `"price"` instead of `"current_price"` unless the user explicitly asks about aliases.
   - Prefer `"notional_quote"` and `"notional_base"` over deprecated aliases.
   - Avoid deprecated OHLC shorthand like `"close@M1[1]"`.
   - Include `order.side` on both open and close rules.
