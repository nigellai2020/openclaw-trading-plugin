import { Type } from "@sinclair/typebox";

const IndicatorConfig = Type.Object({
  type: Type.String({ description: 'Indicator type. Canonical names (aliases in parens): "rsi","sma","ema","macd","stochrsi","stochastic" (alias "stoch"),"bollinger","atr","cci","adx","supertrend","donchian","keltner" (alias "kc"),"parabolic_sar" (aliases "sar","psar"),"ichimoku","linreg" (alias "linear_regression"),"zscore" (alias "z_score"),"heikin_ashi" (alias "ha"),"renko","renko_atr" (alias "renkoatr"),"ohlc". Outputs — single-value (base name only): rsi,sma,ema,atr,cci,zscore. macd: {name}.macd, .signal, .histogram. stochrsi/stochastic: {name}.k, .d. bollinger/donchian/keltner: {name}.upper, .middle, .lower. adx: {name}.adx, .plus_di, .minus_di. supertrend & parabolic_sar: {name}.value, .direction. ichimoku: {name}.tenkan, .kijun, .span_a, .span_b, .chikou. linreg: {name}.slope, .value. heikin_ashi: {name}.open, .high, .low, .close. renko/renko_atr: {name}.brick_high, .brick_low, .direction, .brick_count, .is_new_brick, .brick_size. ohlc: {name}.open, .high, .low, .close, .volume. In rules, use "price" (preferred) or "current_price" for live tick price; no indicator definition needed. Multi-value outputs are referenced from rule strings as "name.field" (e.g. "linreg14.slope", "macd.signal", "adx14.plus_di") — never as separate {indicator, field} sub-keys. Lookback uses "[n]" for n bars ago (max 10): "rsi14[1]", "macd.signal[1]".' }),
  name: Type.String({ description: 'Unique name referenced in rules, e.g. "ema_20_M15"' }),
  period: Type.Optional(Type.Number({ description: "Period/length. Required (>0) for rsi, sma, ema, atr, bollinger, stochastic, cci, linreg, zscore. Optional for indicators with multi-field configs (macd, stochrsi, adx, supertrend, donchian, keltner, parabolic_sar, ichimoku, renko, renko_atr, ohlc, heikin_ashi) — set those via `params`." })),
  timeframe: Type.Optional(Type.String({ description: '"M1","M5","M15","M30","H1","H4","D1"' })),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Indicator-specific settings (defaults shown). EMA/SMA/RSI/CCI/LinReg/ZScore/ADX/Donchian: {period}. MACD: {fast_period=12, slow_period=26, signal_period=9}. Bollinger: {period=20, std_dev=2.0}. StochRSI: {rsi_period=14, stoch_period=14, k_period=3, d_period=3}. Stochastic/stoch: {k_period=14, d_period=3, smooth_k=3}. ATR: {period=14, multiplier=1.0}. SuperTrend: {atr_period=10, multiplier=3.0}. Keltner/kc: {ema_period=20, atr_period=10, multiplier=2.0}. ParabolicSAR (sar/psar): {step=0.02, max_step=0.2}. Ichimoku: {tenkan_period=9, kijun_period=26, senkou_b_period=52}. Renko: {brick_size} (REQUIRED). RenkoATR/renkoatr: {atr_period, atr_multiplier} (both REQUIRED). HeikinAshi/ha and OHLC: no params.',
  })),
});

const SizeConfig = Type.Object({
  mode: Type.String({ description: 'Canonical modes: "all","notional_quote","percent","notional_base". Deprecated aliases still accepted: "fixed_usd" for "notional_quote", and "shares" or "fixed_asset" for "notional_base".' }),
  value: Type.Optional(Type.Number({ description: "Fallback fixed size value. Keep this even when using an expression." })),
  expression: Type.Optional(Type.Unknown({
    description: 'Optional sizing expression AST, e.g. {"operator":"div","operands":[{"number":1000},{"indicator":"atr14"}]}. Prefer keeping value as a safe fallback.',
  })),
});

const OrderConfig = Type.Object({
  type: Type.String({ description: '"market"' }),
  side: Type.Optional(Type.String({ description: '"long" or "short" — required for both open and close rules (must match the position side being opened/closed)' })),
  size: Type.Optional(SizeConfig),
});

export const CopyTradeOrderConfig = Type.Object({
  type: Type.String({ description: '"market"' }),
  size: SizeConfig,
});

const PyramidingConfig = Type.Object({
  enabled: Type.Boolean(),
  max_legs: Type.Number(),
});

const RuleConfig = Type.Object({
  id: Type.String({ description: "Unique rule ID" }),
  intent: Type.String({ description: '"open" or "close"' }),
  when: Type.Unknown({
    description: 'JSON wire format for the backend `When` enum. Top-level shapes (any of): (1) a bare Condition object (single condition — no all/any wrapper needed), (2) {"all":[Condition,...]} every condition true, (3) {"any":[Condition,...]} any condition true, (4) {"profit":{"mode":"percent"|"absolute","value":n,"op":"lt|le|gt|ge|eq|ne","currency":"quote"|"base"}} (op and currency optional), (5) {"profit_pct":n}, (6) {"position_age_secs":n}, (7) {"time_range":{"start":"HH:MM","end":"HH:MM"}} UTC, supports midnight crossover, (8) {"day_of_week":[0..6]} 0=Sun..6=Sat. Condition variants (valid at top level via single, inside all/any arrays, or both): IndicatorComparison {"indicator":"name-or-name.field","op":"lt|le|gt|ge|eq|ne","value":number-or-indicator-name-or-Expression}; CrossCondition {"indicator":"name-or-name.field","op":"crosses_above|crosses_below|lt|gt","other":"name-or-name.field"}; ExpressionCondition {"expression":Expression,"op":"lt|le|gt|ge|eq|ne","value":number-or-indicator-name-or-Expression} (the canonical form for arithmetic on indicators); ExternalSignal {"signal_name":"name","op":"==|!=|>|<|>=|<=","value":"string"}; plus the time_range/day_of_week/profit/profit_pct/position_age_secs forms above. Expression wire format (used inside `expression:` and as a `value:`): leaves {"type":"number","value":n} and {"type":"indicator","name":"rsi14"}; binary ops with left/right operands {"type":"add|sub|mul|div|min|max","left":Expression,"right":Expression}; unary {"type":"abs|neg","expr":Expression}; aggregates {"type":"average","indicator":"rsi14","periods":5}, {"type":"rolling_max","indicator":"bars.high","periods":10}, {"type":"rolling_min","indicator":"bars.low","periods":10} (periods <= 10). Indicator name conventions: multi-value fields use dot notation in the name string ("macd.signal","bb.upper","linreg14.slope"; underscore form "macd_signal" also accepted); lookback appends "[n]" for n bars ago ("rsi14[1]","macd.signal[1]", max 10); pseudo-indicators "price" and "current_price" are always available without declaration. Do NOT use `left_expr` / `right_value` / `right_expr` — those are internal Rust parser field names, not JSON wire format. The serde error "data did not match any variant of untagged enum When" means the shape does not match any of the variants above; the most common cause is using those non-existent field names. For complex patterns (indicator crossing a numeric threshold, direction flips, discrete-value indicators like SuperTrend `.direction`, multi-value indicator references, advanced expression composition), consult the `strategy-reference` skill before constructing the rule.',
  }),
  order: Type.Optional(OrderConfig),
  pyramiding: Type.Optional(PyramidingConfig),
});

const StopLossTakeProfit = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.String({ description: '"percent","absolute","atr"' })),
  value: Type.Optional(Type.Number()),
  atr_indicator: Type.Optional(Type.String()),
});

const TrailingStopConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  start_mode: Type.Optional(Type.String({ description: '"atr" or "percent"' })),
  start_value: Type.Optional(Type.Number()),
  distance_mode: Type.Optional(Type.String({ description: '"breakeven","atr","percent"' })),
  distance_value: Type.Optional(Type.Number()),
  atr_indicator: Type.Optional(Type.String()),
});

const PerBarLimit = Type.Object({
  timeframe: Type.String({ description: '"M1","M5","M15","M30","H1","H4","D1"' }),
  max_trades: Type.Number(),
});

const RiskManagerConfig = Type.Object({
  stop_loss: Type.Optional(StopLossTakeProfit),
  take_profit: Type.Optional(StopLossTakeProfit),
  trailing_stop: Type.Optional(TrailingStopConfig),
  cooldown: Type.Optional(Type.Object({ entry_secs: Type.Optional(Type.Number()) })),
  per_bar_limits: Type.Optional(Type.Array(PerBarLimit)),
  leverage: Type.Optional(Type.Number({ description: "Leverage multiplier" })),
});

export const Strategy = Type.Object({
  name: Type.String({ description: "Strategy name" }),
  symbol: Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' }),
  indicators: Type.Array(IndicatorConfig),
  rules: Type.Array(RuleConfig),
  risk_manager: Type.Optional(RiskManagerConfig),
});

export const SimulationConfig = Type.Object({
  protocol: Type.Optional(Type.String({ description: '"uniswap" or "hyperliquid"' })),
  chain_id: Type.Optional(Type.Number({ description: "Uniswap: 1 (Ethereum), 56 (BSC), 8453 (Base), 42161 (Arbitrum). Hyperliquid: 998 (testnet), 999 (mainnet)." })),
});

export const SimulationConfigPatch = Type.Object({
  protocol: Type.Optional(Type.String({ description: 'Optional partial update for simulation protocol: "uniswap" or "hyperliquid"' })),
  chain_id: Type.Optional(Type.Number({ description: "Optional partial update for simulation chain ID" })),
});
