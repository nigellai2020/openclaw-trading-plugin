import { Type } from "@sinclair/typebox";

const IndicatorConfig = Type.Object({
  type: Type.String({ description: 'Indicator type: "rsi","sma","ema","macd","stochrsi","stochastic","bollinger","atr","renko","renko_atr","ohlc". Outputs — single-value (rsi,sma,ema,atr): {name}. macd: {name}.macd, {name}.signal, {name}.histogram. stochrsi/stochastic: {name}.k, {name}.d. bollinger: {name}.upper, {name}.middle, {name}.lower. renko/renko_atr: {name}.brick_high, {name}.brick_low, {name}.direction. ohlc: {name}.open, {name}.high, {name}.low, {name}.close, {name}.volume. Use "price" for live tick price (no indicator needed).' }),
  name: Type.String({ description: 'Unique name referenced in rules, e.g. "ema_20_M15"' }),
  period: Type.Optional(Type.Number({ description: "Period/length (required for most)" })),
  timeframe: Type.Optional(Type.String({ description: '"M1","M5","M15","M30","H1","H4","D1"' })),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Extra params. EMA/SMA/RSI: {period}. MACD: {fast_period,slow_period,signal_period}. Bollinger: {period,std_dev}. StochRSI: {rsi_period,stoch_period,k_period,d_period}. ATR: {period,multiplier}. Renko: {brick_size}. RenkoATR: {atr_period,atr_multiplier}.',
  })),
});

const SizeConfig = Type.Object({
  mode: Type.String({ description: '"all","fixed_usd","percent","shares","fixed_asset"' }),
  value: Type.Optional(Type.Number()),
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
    description: 'Condition. Simple: {"indicator":"rsi14","op":"lt","value":30}. Cross: {"indicator":"ema20","op":"crosses_above","other":"ema50"}. AND: {"all":[...]}. OR: {"any":[...]}. Profit: {"profit":{"mode":"percent","value":5}}. Age: {"position_age_secs":300}. Ops: lt,le,gt,ge,eq,ne,crosses_above,crosses_below.',
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
  asset_type: Type.String({ description: '"crypto" or "stocks"' }),
  protocol: Type.Optional(Type.String({ description: '"uniswap" or "hyperliquid" (required when asset_type is "crypto")' })),
  chain_id: Type.Optional(Type.Number({ description: "Uniswap: 1 (Ethereum), 56 (BSC), 8453 (Base), 42161 (Arbitrum). Hyperliquid: 998 (testnet), 999 (mainnet). Not needed for stocks." })),
});

export const SimulationConfigPatch = Type.Object({
  asset_type: Type.Optional(Type.String({ description: 'Optional partial update for simulation asset type: "crypto" or "stocks"' })),
  protocol: Type.Optional(Type.String({ description: 'Optional partial update for simulation protocol: "uniswap" or "hyperliquid"' })),
  chain_id: Type.Optional(Type.Number({ description: "Optional partial update for simulation chain ID" })),
});
