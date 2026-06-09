# Strategy JSON API Reference

Complete guide to creating trading strategy JSON files for the Trading Rule Engine.

> Canonical OpenClaw strategy reference. The `strategy-reference` skill should read this file in the current session before answering strategy-schema questions or generating strategy JSON. Do not spawn a subagent just to retrieve this reference.
>
> If this document and `src/schemas/strategy.ts` ever diverge, emit JSON that stays compatible with `src/schemas/strategy.ts` and the registered tool parameter schemas.

## Table of Contents

1. [Overview](#overview)
2. [Root Structure](#root-structure)
3. [Indicators](#indicators)
   - [Common Indicators](#supported-indicators) (RSI, SMA, EMA, MACD, StochRSI, Stochastic, Bollinger Bands, ATR)
   - [Formation Indicators](#9-renko) (Renko, RenkoATR, OHLC)
4. [Expressions](#expressions)
   - [Expression Syntax](#expression-syntax)
   - [Operators](#operators)
   - [Rolling Max/Min Expressions](#rolling-maxmin-expressions)
   - [Usage in Conditions](#usage-in-conditions)
   - [Usage in Position Sizing](#usage-in-position-sizing)
   - [Expression Examples](#expression-examples)
5. [Rules](#rules)
   - [Conditions](#rule-conditions)
   - [Time Range Condition](#9-time-range-condition)
   - [Day of Week Condition](#10-day-of-week-condition)
   - [Order Specification](#order-specification)
   - [Size Modes](#size-modes)
   - [Pyramiding (Scale-In)](#pyramiding-scale-in)
6. [Risk Manager](#risk-manager)
   - [Stop Loss](#stop-loss)
   - [Take Profit](#take-profit)
   - [Trailing Stop](#trailing-stop)
   - [Cooldown](#cooldown)
   - [Per-Bar Limits](#per-bar-limits)
7. [Complete Examples](#complete-examples)

---

## Overview

A strategy JSON file defines a complete trading strategy including:
- **Indicators**: Technical indicators to calculate (RSI, MACD, SMA, etc.)
- **Rules**: Entry and exit conditions based on indicator values
- **Risk Management**: Stop loss, take profit, trailing stops, and trade limits

### Minimal Strategy

```json
{
  "name": "my_strategy",
  "symbol": "ETH/USDC",
  "indicators": [],
  "rules": []
}
```

---

## Root Structure

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for the strategy |
| `symbol` | string | Trading pair symbol (e.g., "ETH/USDC", "BTC/USDC") |
| `indicators` | array | List of technical indicators to calculate |
| `rules` | array | List of trading rules (entry/exit conditions) |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `risk_manager` | object | null | Risk management configuration |

### Example

```json
{
  "name": "trend_following_strategy",
  "symbol": "ETH/USDC",
  "indicators": [...],
  "rules": [...],
  "risk_manager": {...}
}
```

---

## Indicators

Indicators are technical analysis calculations that generate values used in trading rules.

### Common Indicator Structure

```json
{
  "type": "indicator_type",
  "name": "unique_name",
  "period": 14,
  "timeframe": "M1",
  "params": {...}
}
```

### Indicator Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✓ | Indicator type (see [Supported Indicators](#supported-indicators)) |
| `name` | string | ✓ | Unique name to reference this indicator in rules |
| `period` | number | * | Period/length for the indicator (required for most) |
| `timeframe` | string | | Timeframe: "M1", "M5", "M15", "M30", "H1", "H4", "D1" |
| `params` | object | | Additional parameters (varies by indicator type) |

### Supported Indicators

#### 1. RSI (Relative Strength Index)

**Simple Format:**
```json
{
  "type": "rsi",
  "name": "rsi14",
  "period": 14,
  "timeframe": "M1"
}
```

**With Params:**
```json
{
  "type": "rsi",
  "name": "rsi14",
  "timeframe": "M1",
  "params": {
    "period": 14
  }
}
```

**Outputs:** `rsi14` (value: 0-100)

---

#### 2. SMA (Simple Moving Average)

```json
{
  "type": "sma",
  "name": "sma20",
  "period": 20,
  "timeframe": "M1"
}
```

**Outputs:** `sma20` (price value)

---

#### 3. EMA (Exponential Moving Average)

```json
{
  "type": "ema",
  "name": "ema50",
  "period": 50,
  "timeframe": "M1"
}
```

**Alternative with params:**
```json
{
  "type": "ema",
  "name": "ema50",
  "timeframe": "M1",
  "params": {
    "period": 50
  }
}
```

**Outputs:** `ema50` (price value)

---

#### 4. MACD (Moving Average Convergence Divergence)

```json
{
  "type": "macd",
  "name": "macd",
  "timeframe": "M1",
  "params": {
    "fast_period": 12,
    "slow_period": 26,
    "signal_period": 9
  }
}
```

**Parameters:**
- `fast_period`: Fast EMA period (default: 12)
- `slow_period`: Slow EMA period (default: 26)
- `signal_period`: Signal line period (default: 9)

**Outputs:**
- `macd_macd` or `macd.macd`: MACD line value
- `macd_signal` or `macd.signal`: Signal line value
- `macd_histogram` or `macd.histogram`: Histogram value (MACD - Signal)

**Note:** Both `macd_macd` and `macd.macd` formats are supported for referencing outputs.

---

#### 5. StochRSI (Stochastic RSI)

```json
{
  "type": "stochrsi",
  "name": "stochrsi",
  "timeframe": "M1",
  "params": {
    "rsi_period": 14,
    "stoch_period": 14,
    "k_period": 3,
    "d_period": 3
  }
}
```

**Parameters:**
- `rsi_period`: RSI calculation period (default: 14)
- `stoch_period`: Stochastic calculation period (default: 14)
- `k_period`: %K smoothing period (default: 3)
- `d_period`: %D smoothing period (default: 3)

**Outputs:**
- `stochrsi_k`: %K line (0-100)
- `stochrsi_d`: %D line (0-100)

---

#### 6. Stochastic Oscillator

**Format 1:**
```json
{
  "type": "stochastic",
  "name": "stoch",
  "timeframe": "M1",
  "k_period": 14,
  "d_period": 3
}
```

**Format 2:**
```json
{
  "type": "stoch",
  "name": "stoch",
  "timeframe": "M1",
  "params": {
    "k_period": 14,
    "d_period": 3,
    "smooth_k": 3
  }
}
```

**Parameters:**
- `k_period`: %K period (default: 14)
- `d_period`: %D period (default: 3)
- `smooth_k`: %K smoothing period (default: 3)

**Outputs:**
- `stoch_k` or `stoch.k`: %K line (0-100)
- `stoch_d` or `stoch.d`: %D line (0-100)

---

#### 7. Bollinger Bands

**Format 1:**
```json
{
  "type": "bollinger",
  "name": "bb",
  "timeframe": "M1",
  "period": 20,
  "std_dev": 2.0
}
```

**Format 2:**
```json
{
  "type": "bollinger",
  "name": "bb",
  "timeframe": "M1",
  "params": {
    "period": 20,
    "std_dev": 2.0
  }
}
```

**Parameters:**
- `period`: Moving average period (default: 20)
- `std_dev`: Standard deviation multiplier (default: 2.0, typical range: 0.5-5.0)

**Outputs:**
- `bb_upper` or `bb.upper`: Upper band
- `bb_middle` or `bb.middle`: Middle band (SMA)
- `bb_lower` or `bb.lower`: Lower band

---

#### 8. ATR (Average True Range)

```json
{
  "type": "atr",
  "name": "atr14",
  "timeframe": "M1",
  "params": {
    "period": 14,
    "multiplier": 1.0
  }
}
```

**Parameters:**
- `period`: ATR calculation period (default: 14)
- `multiplier`: Multiplier for ATR value (default: 1.0)

**Outputs:** `atr14` (volatility value)

**Note:** ATR is commonly used in ATR-based stop losses and take profits.

---

#### 9. Renko

Renko charts display price movements as "bricks" of a fixed size, filtering out time and focusing purely on price action. Each brick represents a fixed price movement.

```json
{
  "type": "renko",
  "name": "renko_10",
  "period": 1,
  "timeframe": "M1",
  "params": {
    "brick_size": 10.0
  }
}
```

**Parameters:**
- `brick_size` (required): Fixed size of each Renko brick in price units

**Outputs:**
- `renko_10.brick_high`: High price of the current brick
- `renko_10.brick_low`: Low price of the current brick
- `renko_10.direction`: Brick direction (1 = Up, -1 = Down, 0 = None/Not initialized)
- `renko_10.brick_count`: Total number of bricks formed
- `renko_10.is_new_brick`: Whether a new brick was just formed (1 = yes, 0 = no)
- `renko_10.brick_size`: The configured brick size

**Example Usage:**
```json
{
  "id": "renko_buy_signal",
  "intent": "open",
  "when": {
    "all": [
      {
        "indicator": "renko_10.direction",
        "op": "gt",
        "value": 0
      },
      {
        "indicator": "renko_10.is_new_brick",
        "op": "gt",
        "value": 0
      }
    ]
  },
  "order": {
    "type": "market",
    "size": {
      "mode": "notional_quote",
      "value": 1000
    }
  }
}
```

This rule triggers a buy when a new UP brick is formed.

---

#### 10. RenkoATR

RenkoATR uses the Average True Range (ATR) to dynamically adjust the brick size, adapting to market volatility.

```json
{
  "type": "renko_atr",
  "name": "renko_adaptive",
  "period": 14,
  "timeframe": "M1",
  "params": {
    "atr_period": 14,
    "atr_multiplier": 1.5
  }
}
```

**Alternative spelling:** `"renkoatr"` (case-insensitive)

**Parameters:**
- `atr_period` (required): Period for ATR calculation
- `atr_multiplier` (required): Multiplier for ATR value to determine brick size

**Outputs:** Same as Renko indicator
- `renko_adaptive.brick_high`
- `renko_adaptive.brick_low`
- `renko_adaptive.direction`
- `renko_adaptive.brick_count`
- `renko_adaptive.is_new_brick`
- `renko_adaptive.brick_size`: Current ATR-based brick size

**Use Cases:**
- Volatility-adapted trend following
- Dynamic support/resistance levels
- Noise filtering in varying market conditions

---

#### 11. OHLC (Candle Data)

OHLC indicators provide access to candle-based Open, High, Low, Close, and Volume data. Unlike price indicators that give single values, OHLC gives you the full bar structure.

```json
{
  "type": "ohlc",
  "name": "ohlc_m5",
  "period": 1,
  "timeframe": "M5",
  "params": {}
}
```

**Parameters:** None required (empty `params` object)

**Outputs:**
- `ohlc_m5.open`: Opening price of the current candle
- `ohlc_m5.high`: Highest price in the current candle
- `ohlc_m5.low`: Lowest price in the current candle
- `ohlc_m5.close`: Closing price of the current candle
- `ohlc_m5.volume`: Volume for the current candle

**Multi-Timeframe Example:**
```json
{
  "indicators": [
    {
      "type": "ohlc",
      "name": "ohlc_m1",
      "period": 1,
      "timeframe": "M1",
      "params": {}
    },
    {
      "type": "ohlc",
      "name": "ohlc_m5",
      "period": 1,
      "timeframe": "M5",
      "params": {}
    },
    {
      "type": "ohlc",
      "name": "ohlc_m15",
      "period": 1,
      "timeframe": "M15",
      "params": {}
    }
  ],
  "rules": [
    {
      "id": "multi_tf_breakout",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "ohlc_m1.close",
            "op": "gt",
            "other": "ohlc_m5.high"
          },
          {
            "indicator": "ohlc_m5.close",
            "op": "gt",
            "other": "ohlc_m15.high"
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "percent",
          "value": 25
        }
      }
    }
  ]
}
```

**Use Cases:**
- Multi-timeframe analysis
- Breakout strategies (close > high of previous bar)
- Inside bar / outside bar patterns
- High/low of day strategies

**Note:** OHLC indicators support lookback syntax to access historical bars using dot or underscore notation:
```json
{
  "indicator": "ohlc_m5.high[1]",
  "op": "gt",
  "value": 3000
}
```

---

#### 12. ADX (Average Directional Index)

ADX measures trend strength. The `plus_di` and `minus_di` outputs indicate directional movement, while `adx` measures trend intensity.

```json
{
  "type": "adx",
  "name": "adx14",
  "timeframe": "H4",
  "params": { "period": 14 }
}
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `period` | integer | Lookback period (default: 14) |

**Outputs:**
- `adx14.adx`: Trend strength (0–100); values above 25 indicate a strong trend
- `adx14.plus_di`: +DI (positive directional indicator)
- `adx14.minus_di`: −DI (negative directional indicator)

**Example — ADX Trend Filter with DI Crossover:**
```json
{
  "indicators": [
    {
      "type": "adx",
      "name": "adx14",
      "timeframe": "H4",
      "params": { "period": 14 }
    }
  ],
  "rules": [
    {
      "id": "adx_long_entry",
      "intent": "open",
      "when": {
        "all": [
          { "indicator": "adx14.adx",      "op": "gt",            "value": 25 },
          { "indicator": "adx14.plus_di",  "op": "crosses_above", "other": "adx14.minus_di" }
        ]
      },
      "order": { "side": "long", "type": "market", "size": { "mode": "percent", "value": 100 } }
    }
  ]
}
```

**Use Cases:**
- Filter entries to only trade when trend strength is confirmed (`adx > 25`)
- DI crossovers for directional bias
- Exit when ADX drops below 20 (trend exhaustion)

---

#### 13. SuperTrend

SuperTrend is an ATR-based trend-following indicator that provides a support/resistance price level and a directional signal (+1 bullish, −1 bearish).

```json
{
  "type": "supertrend",
  "name": "st",
  "timeframe": "H4",
  "params": { "atr_period": 10, "multiplier": 3.0 }
}
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `atr_period` | integer | ATR lookback period (default: 10) |
| `multiplier` | float | ATR multiplier for band width (default: 3.0) |

**Outputs:**
- `st.value`: SuperTrend price level (acts as trailing stop)
- `st.direction`: +1 when bullish (price above band), −1 when bearish (price below band)

**Detecting Direction Flip (Cross Approximation):**

Because `direction` is a discrete step value (+1/−1) rather than a continuous indicator, use the two-condition lookback pattern to approximate a crossover:

```json
{
  "when": {
    "all": [
      { "indicator": "st.direction[1]", "op": "lt", "value": 0 },
      { "indicator": "st.direction",    "op": "gt", "value": 0 }
    ]
  }
}
```

**Example — SuperTrend Trend-Following:**
```json
{
  "indicators": [
    {
      "type": "supertrend",
      "name": "st",
      "timeframe": "H4",
      "params": { "atr_period": 10, "multiplier": 3.0 }
    }
  ],
  "rules": [
    {
      "id": "st_long",
      "intent": "open",
      "when": {
        "all": [
          { "indicator": "st.direction[1]", "op": "lt", "value": 0 },
          { "indicator": "st.direction",    "op": "gt", "value": 0 }
        ]
      },
      "order": { "side": "long", "type": "market", "size": { "mode": "percent", "value": 100 } }
    },
    {
      "id": "st_exit_long",
      "intent": "close",
      "when": { "indicator": "st.direction", "op": "lt", "value": 0 },
      "order": { "type": "market", "size": { "mode": "all" } }
    }
  ]
}
```

**Use Cases:**
- Trend-following entries on direction flip
- Dynamic trailing stop using `st.value` as a price level reference
- Multi-timeframe trend confirmation (H4 direction filter + M15 entry)

---

#### 14. Donchian Channel

Donchian Channels track the highest high and lowest low over a period, forming breakout channels.

```json
{
  "type": "donchian",
  "name": "dc20",
  "timeframe": "D1",
  "params": { "period": 20 }
}
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `period` | integer | Lookback period for high/low calculation (default: 20) |

**Outputs:**
- `dc20.upper`: Highest high over `period` bars
- `dc20.lower`: Lowest low over `period` bars
- `dc20.middle`: Midpoint `(upper + lower) / 2`

**Example — Donchian Breakout:**
```json
{
  "indicators": [
    {
      "type": "donchian",
      "name": "dc20",
      "timeframe": "D1",
      "params": { "period": 20 }
    }
  ],
  "rules": [
    {
      "id": "donchian_breakout_long",
      "intent": "open",
      "when": { "indicator": "price", "op": "crosses_above", "other": "dc20.upper" },
      "order": { "side": "long", "type": "market", "size": { "mode": "percent", "value": 100 } }
    },
    {
      "id": "donchian_exit_long",
      "intent": "close",
      "when": { "indicator": "price", "op": "lt", "other": "dc20.middle" },
      "order": { "type": "market", "size": { "mode": "all" } }
    }
  ]
}
```

**Use Cases:**
- Turtle-style channel breakout systems
- Support/resistance levels using upper/lower bands
- Middle band as a mean-reversion target

---

#### 15. Keltner Channel

Keltner Channels are volatility-based envelopes set above and below an EMA using ATR. They are similar to Bollinger Bands but use ATR instead of standard deviation.

```json
{
  "type": "keltner",
  "name": "kc",
  "timeframe": "H4",
  "params": { "ema_period": 20, "atr_period": 10, "multiplier": 2.0 }
}
```

**Alias:** `"type": "kc"` is also accepted.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ema_period` | integer | EMA period for the middle band (default: 20) |
| `atr_period` | integer | ATR period for band width (default: 10) |
| `multiplier` | float | ATR multiplier for band distance (default: 2.0) |

**Outputs:**
- `kc.upper`: Upper channel band (`EMA + multiplier × ATR`)
- `kc.middle`: Middle EMA line
- `kc.lower`: Lower channel band (`EMA − multiplier × ATR`)

**Example — Keltner Channel Breakout:**
```json
{
  "indicators": [
    {
      "type": "keltner",
      "name": "kc",
      "timeframe": "H4",
      "params": { "ema_period": 20, "atr_period": 10, "multiplier": 2.0 }
    }
  ],
  "rules": [
    {
      "id": "kc_breakout_long",
      "intent": "open",
      "when": { "indicator": "price", "op": "crosses_above", "other": "kc.upper" },
      "order": { "side": "long", "type": "market", "size": { "mode": "percent", "value": 100 } }
    },
    {
      "id": "kc_mean_revert",
      "intent": "close",
      "when": { "indicator": "price", "op": "lt", "other": "kc.middle" },
      "order": { "type": "market", "size": { "mode": "all" } }
    }
  ]
}
```

**Combining Keltner + Bollinger Bands (Squeeze Detection):**
```json
{
  "all": [
    { "indicator": "bb_upper",  "op": "lt", "other": "kc.upper"  },
    { "indicator": "bb_lower",  "op": "gt", "other": "kc.lower"  }
  ]
}
```
When Bollinger Bands are inside the Keltner Channel, a volatility squeeze is forming — a precursor to a breakout.

**Use Cases:**
- Volatility breakout entries when price exits the channel
- Mean reversion to the middle EMA
- Squeeze detection combined with Bollinger Bands

---

#### 16. Parabolic SAR

Parabolic SAR (Stop and Reverse) is a trend-following indicator that provides potential reversal points. The `direction` field is `1` (bullish) or `-1` (bearish).

**Configuration:**
```json
{
  "type": "sar",
  "name": "sar",
  "timeframe": "H1",
  "params": { "step": 0.02, "max_step": 0.2 }
}
```

**Alternative type names:** `"parabolic_sar"`, `"psar"`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `step` | float | 0.02 | Acceleration factor step size |
| `max_step` | float | 0.2 | Maximum acceleration factor |

**Output fields:** `{name}.value`, `{name}.direction`

**Example — SAR Direction Flip:**
```json
{
  "all": [
    { "indicator": "sar.direction[1]", "op": "lt", "value": 0 },
    { "indicator": "sar.direction",    "op": "gt", "value": 0 }
  ]
}
```

**Use Cases:**
- Trend reversal entry on direction flip
- Trailing stop replacement using SAR value
- Trend filter combined with momentum indicators

---

#### 17. Ichimoku Cloud

Ichimoku Kinko Hyo is a comprehensive trend indicator providing support/resistance, momentum, and direction signals in one system.

**Configuration:**
```json
{
  "type": "ichimoku",
  "name": "ich",
  "timeframe": "H4",
  "params": { "tenkan_period": 9, "kijun_period": 26, "senkou_b_period": 52 }
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tenkan_period` | int | 9 | Tenkan-sen (Conversion line) period |
| `kijun_period` | int | 26 | Kijun-sen (Base line) period |
| `senkou_b_period` | int | 52 | Senkou Span B period (cloud width) |

**Output fields:** `{name}.tenkan`, `{name}.kijun`, `{name}.span_a`, `{name}.span_b`, `{name}.chikou`

**Example — Tenkan/Kijun Crossover:**
```json
{ "indicator": "ich.tenkan", "op": "crosses_above", "other": "ich.kijun" }
```

**Example — Price Above Cloud:**
```json
{
  "all": [
    { "indicator": "price", "op": "gt", "other": "ich.span_a" },
    { "indicator": "price", "op": "gt", "other": "ich.span_b" }
  ]
}
```

**Use Cases:**
- Tenkan/Kijun crossovers for trend entries
- Cloud breakouts for momentum trades
- Kijun bounce trades in trending markets
- Crypto-adjusted periods (10/30/60) for 24/7 markets

---

#### 18. CCI (Commodity Channel Index)

CCI measures price deviation from its statistical average. Values above +100 indicate overbought; below -100 indicate oversold.

**Configuration:**
```json
{ "type": "cci", "name": "cci20", "period": 20, "timeframe": "H1" }
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | int | 20 | Lookback period |

**Output:** Single value (access directly as `{name}`)

**Example — Mean Reversion at ±100:**
```json
{ "indicator": "cci20[1]", "op": "lt", "value": -100 }
```
then:
```json
{ "indicator": "cci20", "op": "gt", "value": -100 }
```

**Use Cases:**
- Mean reversion at ±100 or ±200 thresholds
- Zero-line crossover for trend-following
- EMA-filtered entries to avoid counter-trend trades

---

#### 19. Heikin-Ashi

Heikin-Ashi candles smooth price action to make trends more visible. Bullish candles have `close > open`; bearish candles have `close < open`.

**Configuration:**
```json
{
  "type": "heikin_ashi",
  "name": "ha",
  "timeframe": "H1"
}
```

**Alternative type names:** `"ha"`

No parameters are required. 

**Output fields:** `{name}.open`, `{name}.high`, `{name}.low`, `{name}.close`

**Example — HA Color Change (Bullish):**
```json
{
  "all": [
    { "indicator": "ha.close[1]", "op": "lt", "other": "ha.open[1]" },
    { "indicator": "ha.close",    "op": "gt", "other": "ha.open" }
  ]
}
```

**Use Cases:**
- Color change entries at trend reversals
- Trend continuation trades when HA stays same color
- Combined with EMA or RSI for confirmation signals

---

#### 20. Linear Regression

Fits an ordinary least-squares regression line through the last N prices. Outputs the regression value at the current bar and the slope of the line.

**Configuration:**
```json
{ "type": "linreg", "name": "lr14", "period": 14, "timeframe": "H1" }
```

**Alternative type names:** `"linear_regression"`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | int (≥2) | 14 | Number of bars for regression |

**Output fields:** `{name}.slope`, `{name}.value`

**Example — Slope-based Trend Filter:**
```json
{
  "all": [
    { "indicator": "lr14.slope", "op": "gt", "value": 0 },
    { "indicator": "price", "op": "crosses_above", "other": "ema20" }
  ]
}
```

**Use Cases:**
- Slope as a trend filter (positive = uptrend)
- Slope crossover for trend-following entries
- Price vs regression value for mean reversion

---

#### 21. Z-Score

Z-Score measures how many standard deviations the current price is from its rolling mean. Common thresholds: ±2 for mean reversion, ±3 for extreme moves.

**Configuration:**
```json
{ "type": "zscore", "name": "z20", "period": 20, "timeframe": "H1" }
```

**Alternative type names:** `"z_score"`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | int | 20 | Rolling window length |

**Output:** Single value (access directly as `{name}`)

**Example — Mean Reversion at ±2:**
```json
{ "indicator": "z20[1]", "op": "lt", "value": -2 }
```
then:
```json
{ "indicator": "z20", "op": "gt", "value": -2 }
```

**Use Cases:**
- Mean reversion at statistical extremes (±2 or ±3)
- Zero-line crossover for trend-following
- EMA-filtered entries (long only above EMA, short only below)

---

### Current Price Reference

You can reference the current live market price in rules using the `"price"` indicator:

```json
{
  "indicator": "price",
  "op": "gt",
  "other": "sma20"
}
```

The `"price"` indicator refers to the **current live tick price** and requires no indicator definition. It's useful for:
- Comparing current price against moving averages
- Simple threshold-based entries/exits
- Quick price comparisons without bar/candle data

**Alternative Names:** `"current_price"` is also supported as an alias for `"price"`.

**Example - Price Above SMA:**
```json
{
  "id": "price_above_sma",
  "intent": "open",
  "when": {
    "indicator": "price",
    "op": "gt",
    "other": "sma20"
  }
}
```

---

### Bar-Based Price Data (OHLC)

For bar/candle-based strategies, **define an OHLC indicator** to access open, high, low, close, and volume data:

```json
{
  "indicators": [
    {
      "type": "ohlc",
      "name": "ohlc_m1",
      "period": 1,
      "timeframe": "M1",
      "params": {}
    }
  ],
  "rules": [
    {
      "id": "breakout_strategy",
      "intent": "open",
      "when": {
        "indicator": "ohlc_m1.close",
        "op": "gt",
        "other": "ohlc_m1.high[1]"
      }
    }
  ]
}
```

OHLC indicators provide:
- **Historical lookback**: Access previous bar data with `[1]`, `[2]`, etc.
- **All OHLC components**: `open`, `high`, `low`, `close`, `volume`
- **Multi-timeframe support**: Define separate OHLC indicators for each timeframe

**When to use:**
- ✅ Use `"price"` for simple current price comparisons
- ✅ Use OHLC indicators (`ohlc_m1.close`) for bar-based strategies with lookback

---

## Expressions

Expressions enable **dynamic calculations** and **complex logic** in your trading rules. Instead of using static values, you can perform arithmetic operations on indicators, combine multiple indicators, and create sophisticated conditions and position sizing formulas.

### Expression Syntax

Expressions use a tagged JSON format where each node has a `"type"` field indicating the operation.

**Leaf nodes:**
```json
{ "type": "number", "value": 42.5 }
{ "type": "indicator", "name": "rsi14" }
```

**Nested expressions** can be used anywhere an operand is expected.

### Operators

#### Arithmetic Operators (binary — `left` and `right` fields)

| Type | Description | Example |
|------|-------------|---------|
| `add` | Addition | `{"type": "add", "left": {"type": "number", "value": 100}, "right": {"type": "indicator", "name": "rsi14"}}` |
| `sub` | Subtraction | `{"type": "sub", "left": {"type": "indicator", "name": "rsi14"}, "right": {"type": "indicator", "name": "rsi14[1]"}}` |
| `mul` | Multiplication | `{"type": "mul", "left": {"type": "number", "value": 500}, "right": {"type": "indicator", "name": "macd_histogram"}}` |
| `div` | Division | `{"type": "div", "left": {"type": "number", "value": 1000}, "right": {"type": "indicator", "name": "atr14"}}` |
| `min` | Minimum of two | `{"type": "min", "left": {"type": "indicator", "name": "price"}, "right": {"type": "number", "value": 3000}}` |
| `max` | Maximum of two | `{"type": "max", "left": {"type": "indicator", "name": "atr14"}, "right": {"type": "number", "value": 5}}` |

#### Unary Operators (single operand — `expr` field)

| Type | Description | Example |
|------|-------------|---------|
| `abs` | Absolute value | `{"type": "abs", "expr": {"type": "indicator", "name": "macd_histogram"}}` |
| `neg` | Negation | `{"type": "neg", "expr": {"type": "indicator", "name": "rsi14"}}` |

#### Aggregate Operators

| Type | Description | Fields |
|------|-------------|--------|
| `average` | Rolling mean of indicator over N bars | `{"type": "average", "indicator": "rsi14", "periods": 5}` |

---

### Rolling Max/Min Expressions

`rolling_max` and `rolling_min` compute the maximum or minimum value of an indicator over the last N closed bars. They use the same bar history as lookback (`[n]`) — up to **10 bars** of history.

#### Syntax

```json
{ "type": "rolling_max", "indicator": "<name>", "periods": N }
{ "type": "rolling_min", "indicator": "<name>", "periods": N }
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"rolling_max"` or `"rolling_min"` |
| `indicator` | string | Indicator name (supports dot notation, e.g., `"bars.high"`) |
| `periods` | integer | Look-back window, 1–10 |

> **Limit:** `periods` must be ≤ 10 (the maximum bar history depth). Using a larger value silently clamps to available history.

#### OHLC Component Support

When you have an OHLC indicator named `"bars"`, you can reference its price components:
- `"bars.high"` / `"bars_high"` — high price history
- `"bars.low"` / `"bars_low"` — low price history
- `"bars.close"` / `"bars_close"` — close price history

#### Usage in ExpressionCondition

Rolling expressions are used inside an `ExpressionCondition`:

```json
{
  "expression": { "type": "...", ... },
  "op": "gt|lt|ge|le|eq",
  "value": <number or indicator name>
}
```

Use `"value": "price"` to compare against the current tick price.

#### Examples

**Chandelier Exit stop check** — is current price below the recent high minus 2×ATR?
```json
{
  "expression": {
    "type": "sub",
    "left":  { "type": "rolling_max", "indicator": "bars.high", "periods": 10 },
    "right": { "type": "mul",
               "left":  { "type": "number",    "value": 2.0 },
               "right": { "type": "indicator", "name": "atr14" } }
  },
  "op": "gt",
  "value": "price"
}
```
Fires when `rolling_max(bars.high, 10) - 2*ATR > price`, i.e., price has dropped below the Chandelier Exit stop.

**Donchian channel breakout** — price above the 10-bar high:
```json
{
  "expression": { "type": "rolling_max", "indicator": "bars.high", "periods": 10 },
  "op": "lt",
  "value": "price"
}
```
Fires when `rolling_max(bars.high, 10) < price`, i.e., price breaks above the recent range.

**ATR-squeeze filter** — current ATR is below 77% of its 10-bar peak:
```json
{
  "expression": { "type": "rolling_max", "indicator": "atr14", "periods": 10 },
  "op": "gt",
  "value": {
    "type": "mul",
    "left":  { "type": "number",    "value": 1.3 },
    "right": { "type": "indicator", "name": "atr14" }
  }
}
```
Fires when `rolling_max(atr14, 10) > 1.3 * atr14`, i.e., current ATR is less than 77% of its recent peak (a volatility squeeze).

---

### Usage in Conditions

Expressions are used inside an `ExpressionCondition` with `expression`, `op`, and `value` fields:

```json
{
  "expression": <expression-node>,
  "op": "gt|lt|ge|le|eq|ne",
  "value": <number, indicator-name, or expression-node>
}
```

**Example: RSI Slope Detection**
```json
{
  "id": "rsi_rising",
  "intent": "open",
  "when": {
    "expression": {
      "type": "sub",
      "left": {"type": "indicator", "name": "rsi14"},
      "right": {"type": "indicator", "name": "rsi14[1]"}
    },
    "op": "gt",
    "value": 0
  }
}
```

**Example: Bollinger Band Compression (current width < previous bar's width)**
```json
{
  "id": "bb_squeeze",
  "intent": "open",
  "when": {
    "expression": {
      "type": "sub",
      "left": {"type": "indicator", "name": "bb_upper"},
      "right": {"type": "indicator", "name": "bb_lower"}
    },
    "op": "lt",
    "value": {
      "type": "sub",
      "left": {"type": "indicator", "name": "bb_upper[1]"},
      "right": {"type": "indicator", "name": "bb_lower[1]"}
    }
  }
}
```

### Usage in Position Sizing

Expressions enable **dynamic position sizing** based on market conditions, volatility, or indicator strength.

**Example: Inverse ATR Sizing (Volatility-Adjusted)**
```json
{
  "order": {
    "type": "market",
    "size": {
      "mode": "notional_quote",
      "value": 1000,
      "expression": {
        "type": "div",
        "left": {"type": "number", "value": 1000},
        "right": {"type": "indicator", "name": "atr14"}
      }
    }
  }
}
```

When ATR is high (volatile market), position size decreases. When ATR is low (quiet market), position size increases.

**Example: Momentum-Based Sizing**
```json
{
  "order": {
    "type": "market",
    "size": {
      "mode": "notional_quote",
      "value": 500,
      "expression": {
        "type": "mul",
        "left": {"type": "number", "value": 500},
        "right": {
          "type": "abs",
          "expr": {"type": "indicator", "name": "macd_histogram"}
        }
      }
    }
  }
}
```

Position size scales with MACD histogram strength.

### Expression Examples

**1. RSI Momentum (Rate of Change)**
```json
{
  "type": "sub",
  "left": {"type": "indicator", "name": "rsi14"},
  "right": {"type": "indicator", "name": "rsi14[1]"}
}
```

**2. Dynamic Stop Distance (Multiple of ATR)**
```json
{
  "type": "mul",
  "left": {"type": "indicator", "name": "atr14"},
  "right": {"type": "number", "value": 2.0}
}
```

**3. Bollinger Band Width**
```json
{
  "type": "sub",
  "left": {"type": "indicator", "name": "bb_upper"},
  "right": {"type": "indicator", "name": "bb_lower"}
}
```

**4. Normalized Indicator (0-1 Range)**
```json
{
  "type": "div",
  "left": {"type": "indicator", "name": "rsi14"},
  "right": {"type": "number", "value": 100}
}
```

**5. Rolling Average of Indicator**
```json
{
  "type": "average",
  "indicator": "rsi14",
  "periods": 3
}
```

**6. Price Distance from Moving Average**
```json
{
  "type": "sub",
  "left": {"type": "indicator", "name": "price"},
  "right": {"type": "indicator", "name": "sma20"}
}
```

### Safety Features

Expression evaluation includes built-in safety checks:

- **Division by Zero**: Returns error instead of infinity
- **NaN Detection**: Catches invalid calculations
- **Infinity Protection**: Prevents overflow errors
- **Fallback Values**: Uses `size.value` if expression evaluation fails

**Example with Error Handling:**
```json
{
  "size": {
    "mode": "notional_quote",
    "value": 1000,
    "expression": {
      "type": "div",
      "left": {"type": "number", "value": 1000},
      "right": {"type": "indicator", "name": "atr14"}
    }
  }
}
```

If `atr14` is 0 or missing, the engine falls back to `value: 1000`.

### Best Practices

1. **Always provide a fallback `value`**: Expression errors will use this as a safe default
2. **Use meaningful indicator names**: `rsi14[1]` for previous RSI, not `rsi14_prev`
3. **Avoid deep nesting**: Complex expressions are harder to debug
4. **Test with edge cases**: Verify behavior when indicators are 0, NaN, or missing
5. **Document complex logic**: Add comments in your strategy JSON explaining formulas

### Complete Expression Examples

See `examples/expressions/` directory for full strategy examples:
- `rsi_slope.json` - RSI momentum detection
- `inverse_atr_sizing.json` - Volatility-adjusted position sizing
- `macd_histogram_sizing.json` - Momentum-based sizing
- `bollinger_squeeze.json` - Band width compression
- `README.md` - Comprehensive documentation

---

## Rules

Rules define the entry and exit logic for your strategy. Each rule specifies a condition and what action to take when the condition is met.

### Rule Structure

```json
{
  "id": "unique_rule_id",
  "intent": "open",
  "when": {...},
  "order": {...},
  "pyramiding": {...}
}
```

### Rule Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier for this rule |
| `intent` | string | ✓ | "open" (enter position) or "close" (exit position) |
| `when` | object | ✓ | Condition that triggers the rule |
| `order` | object | | Order specification (type and size) |
| `pyramiding` | object | | Pyramiding/scaling configuration |

---

### Intent Types

#### 1. `"open"` - Entry Rules

Opens a new position or adds to an existing position (if pyramiding is enabled).

```json
{
  "id": "buy_oversold",
  "intent": "open",
  "when": {
    "indicator": "rsi14",
    "op": "lt",
    "value": 30
  }
}
```

#### 2. `"close"` - Exit Rules

Closes all or part of the current position.

```json
{
  "id": "sell_overbought",
  "intent": "close",
  "when": {
    "indicator": "rsi14",
    "op": "gt",
    "value": 70
  }
}
```

---

### Conditions (`when` clause)

Conditions determine when a rule fires. There are several types:

#### 1. Simple Indicator Comparison

Compare an indicator value against a fixed number:

```json
{
  "indicator": "rsi14",
  "op": "lt",
  "value": 30
}
```

**Operators:**
- `"lt"`: Less than (<)
- `"le"`: Less than or equal (≤)
- `"gt"`: Greater than (>)
- `"ge"`: Greater than or equal (≥)
- `"eq"`: Equal (=)
- `"ne"`: Not equal (≠)

---

#### 2. Compare Two Indicators

Compare an indicator against another indicator:

```json
{
  "indicator": "ema20",
  "op": "gt",
  "other": "ema50"
}
```

---

#### 3. Cross Detection

Detect when one indicator crosses above or below another:

```json
{
  "indicator": "macd.macd",
  "op": "crosses_above",
  "other": "macd.signal"
}
```

**Cross Operators:**
- `"crosses_above"`: Indicator crosses above the other (was below, now above)
- `"crosses_below"`: Indicator crosses below the other (was above, now below)

**Example:**
```json
{
  "id": "golden_cross",
  "intent": "open",
  "when": {
    "indicator": "ema20",
    "op": "crosses_above",
    "other": "ema50"
  }
}
```

---

#### 4. Historical Values (Lookback)

Reference previous indicator values using bracket notation `[n]` where `n` is the number of bars ago.

##### Basic Lookback Syntax

```json
{
  "indicator": "rsi14",
  "op": "gt",
  "value": "rsi14[1]"
}
```

- `rsi14[0]`: Current value (same as `rsi14`)
- `rsi14[1]`: Previous value (1 bar ago)
- `rsi14[2]`: 2 bars ago
- etc.

##### OHLC Price Lookback

**RECOMMENDED APPROACH:** Define an OHLC indicator first, then reference its components with lookback:

```json
{
  "indicators": [
    {
      "type": "ohlc",
      "name": "ohlc_m1",
      "period": 1,
      "timeframe": "M1",
      "params": {}
    }
  ],
  "rules": [
    {
      "id": "breakout",
      "intent": "open",
      "when": {
        "indicator": "ohlc_m1.close",
        "op": "gt",
        "other": "ohlc_m1.high[1]"
      }
    }
  ]
}
```

**Supported OHLC component references:**
- `ohlc_m1.close` or `ohlc_m1_close`: Current close price
- `ohlc_m1.close[1]` or `ohlc_m1_close[1]`: Previous bar's close price
- `ohlc_m1.high[1]` or `ohlc_m1_high[1]`: Previous bar's high price
- `ohlc_m1.low[1]` or `ohlc_m1_low[1]`: Previous bar's low price
- `ohlc_m1.open[1]` or `ohlc_m1_open[1]`: Previous bar's open price

Both **dot notation** (`ohlc_m1.close`) and **underscore notation** (`ohlc_m1_close`) are supported and equivalent.

##### Multi-Value Indicator Lookback

All multi-value indicators support lookback on their individual components:

**MACD:**
```json
{
  "indicator": "macd_signal",
  "op": "gt",
  "other": "macd_signal[1]"
}
```
- `macd_macd[1]`: MACD line 1 bar ago
- `macd_signal[1]`: Signal line 1 bar ago
- `macd_histogram[1]`: Histogram 1 bar ago

**StochRSI:**
```json
{
  "indicator": "stochrsi_k",
  "op": "gt",
  "other": "stochrsi_k[1]"
}
```
- `stochrsi_k[1]`: %K line 1 bar ago
- `stochrsi_d[1]`: %D line 1 bar ago

**Stochastic:**
```json
{
  "indicator": "stoch_k",
  "op": "crosses_above",
  "other": "stoch_d"
}
```
- `stoch_k[1]`: %K line 1 bar ago
- `stoch_d[1]`: %D line 1 bar ago

**Bollinger Bands:**
```json
{
  "indicator": "ohlc_m1.close",
  "op": "lt",
  "other": "bb_lower[1]"
}
```
- `bb_upper[1]`: Upper band 1 bar ago
- `bb_middle[1]`: Middle band 1 bar ago
- `bb_lower[1]`: Lower band 1 bar ago

**OHLC Components:**
```json
{
  "indicator": "ohlc_m1.close",
  "op": "gt",
  "other": "ohlc_m1.open"
}
```
- `ohlc_m1.open[1]` or `ohlc_m1_open[1]`: Open price 1 bar ago
- `ohlc_m1.high[1]` or `ohlc_m1_high[1]`: High price 1 bar ago
- `ohlc_m1.low[1]` or `ohlc_m1_low[1]`: Low price 1 bar ago
- `ohlc_m1.close[1]` or `ohlc_m1_close[1]`: Close price 1 bar ago

##### Example - Rising RSI:
```json
{
  "all": [
    {
      "indicator": "rsi14",
      "op": "lt",
      "value": 30
    },
    {
      "indicator": "rsi14",
      "op": "gt",
      "value": "rsi14[1]"
    }
  ]
}
```

##### Example - MACD Momentum Building:
```json
{
  "all": [
    {
      "indicator": "macd_histogram",
      "op": "gt",
      "value": 0
    },
    {
      "indicator": "macd_histogram",
      "op": "gt",
      "other": "macd_histogram[1]"
    },
    {
      "indicator": "macd_histogram[1]",
      "op": "gt",
      "other": "macd_histogram[2]"
    }
  ]
}
```

##### Example - Price Above Previous Swing High:
```json
{
  "indicator": "ohlc_m1.close",
  "op": "gt",
  "other": "ohlc_m1.high[1]"
}
```

This checks if the current close price is higher than the previous bar's high (a breakout condition).

**Note:** History is maintained for up to 10 bars for each indicator and OHLC component value.

---

#### 5. Compound Conditions - `all`

All conditions must be true (logical AND):

```json
{
  "all": [
    {
      "indicator": "rsi14",
      "op": "lt",
      "value": 30
    },
    {
      "indicator": "price",
      "op": "gt",
      "other": "sma20"
    },
    {
      "indicator": "macd.histogram",
      "op": "gt",
      "value": 0
    }
  ]
}
```

---

#### 6. Compound Conditions - `any`

At least one condition must be true (logical OR):

```json
{
  "any": [
    {
      "indicator": "rsi14",
      "op": "gt",
      "value": 80
    },
    {
      "indicator": "stoch.k",
      "op": "gt",
      "value": 90
    }
  ]
}
```

---

#### 7. Profit Condition

Exit when position reaches a profit threshold, with support for percentage or absolute profit values and flexible comparison operators.

**Structure:**
```json
{
  "profit": {
    "mode": "percent",     // "percent" | "absolute"
    "value": 5.0,          // numeric threshold
    "currency": "quote",   // "quote" | "asset" (optional, only for absolute mode)
    "op": "ge"             // "gt" | "ge" | "lt" | "le" | "eq" | "ne" (optional, default: "ge")
  }
}
```

**Modes:**
- `"percent"`: Profit percentage relative to entry price (e.g., 5.0 = 5%)
- `"absolute"`: Absolute profit value in specified currency

**Currency (for absolute mode):**
- `"quote"`: Profit in quote currency (e.g., USD, USDC) - default
- `"asset"`: Profit in asset units (e.g., ETH, BTC)

**Comparison Operators:**
- `"gt"`: Greater than (>)
- `"ge"`: Greater than or equal (≥) - **default**
- `"lt"`: Less than (<)
- `"le"`: Less than or equal (≤)
- `"eq"`: Equal (=)
- `"ne"`: Not equal (≠)

**Examples:**

**Close when profit is positive (> 0%):**
```json
{
  "id": "exit_profitable",
  "intent": "close",
  "when": {
    "profit": {
      "mode": "percent",
      "value": 0.0,
      "op": "gt"
    }
  }
}
```

**Close when profit ≥ 5%:**
```json
{
  "id": "take_profit_5pct",
  "intent": "close",
  "when": {
    "profit": {
      "mode": "percent",
      "value": 5.0
    }
  }
}
```

**Close when profit in quote currency ≥ $100:**
```json
{
  "id": "take_profit_100usd",
  "intent": "close",
  "when": {
    "profit": {
      "mode": "absolute",
      "value": 100.0,
      "currency": "quote"
    }
  }
}
```

**Close when profit in asset units ≥ 0.1 ETH:**
```json
{
  "id": "take_profit_01eth",
  "intent": "close",
  "when": {
    "profit": {
      "mode": "absolute",
      "value": 0.1,
      "currency": "asset"
    }
  }
}
```

**Using with compound conditions (all/any):**
```json
{
  "id": "conditional_exit",
  "intent": "close",
  "when": {
    "all": [
      {
        "profit": {
          "mode": "percent",
          "value": 2.0,
          "op": "gt"
        }
      },
      {
        "indicator": "rsi14",
        "op": "gt",
        "value": 70
      }
    ]
  }
}
```

---

#### 8. Position Age

Exit when position has been open for a specific duration:

```json
{
  "position_age_secs": 300
}
```

**Example - Exit after 5 minutes:**
```json
{
  "id": "timed_exit",
  "intent": "close",
  "when": {
    "position_age_secs": 300
  }
}
```

**Common Durations:**
- 60 seconds = 1 minute
- 300 seconds = 5 minutes
- 3600 seconds = 1 hour
- 86400 seconds = 1 day

---

#### 9. Time Range Condition

Only fire during a specific UTC time window. Useful for restricting trades to exchange sessions (London, New York, Asian).

```json
{
  "time_range": {
    "start": "08:00",
    "end":   "16:00"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `start` | string | Window start in `"HH:MM"` 24-hour UTC format (inclusive) |
| `end` | string | Window end in `"HH:MM"` 24-hour UTC format (exclusive) |

- `start` and `end` must differ.
- Midnight crossover is supported: `start: "21:00", end: "05:00"` covers 21:00–05:00 UTC.
- Evaluation uses the tick timestamp (`ctx.ts`), so results are deterministic during backtesting.

**Example — London session only:**
```json
{
  "id": "london_entry",
  "intent": "open",
  "when": {
    "all": [
      { "time_range": { "start": "08:00", "end": "16:00" } },
      { "indicator": "ema20", "op": "crosses_above", "other": "ema50" }
    ]
  }
}
```

**Example — Overnight session (midnight crossover):**
```json
{
  "id": "overnight_exit",
  "intent": "close",
  "when": {
    "time_range": { "start": "21:00", "end": "05:00" }
  }
}
```

**Common session windows (UTC):**
| Session | Start | End |
|---------|-------|-----|
| Asian | `00:00` | `08:00` |
| London | `08:00` | `16:00` |
| New York | `14:00` | `21:00` |
| London+NY overlap | `14:00` | `16:00` |

---

#### 10. Day of Week Condition

Only fire on specific days of the week. Useful for avoiding low-liquidity weekends or Monday gaps.

```json
{
  "day_of_week": [1, 2, 3, 4, 5]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `day_of_week` | array of integers | Allowed days: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday |

- At least one day must be specified.
- All values must be in the range 0–6.
- Evaluation uses the tick timestamp (`ctx.ts`), matching `getDay()` convention from JavaScript.

**Example — Weekdays only (avoid weekend volatility):**
```json
{
  "id": "weekday_rsi_long",
  "intent": "open",
  "when": {
    "all": [
      { "day_of_week": [1, 2, 3, 4, 5] },
      { "indicator": "rsi14", "op": "lt", "value": 30 }
    ]
  }
}
```

**Example — Exclude Monday (skip first-day gaps):**
```json
{
  "id": "no_monday_entry",
  "intent": "open",
  "when": {
    "all": [
      { "day_of_week": [0, 2, 3, 4, 5, 6] },
      { "indicator": "ema20", "op": "gt", "other": "ema50" }
    ]
  }
}
```

**Day reference:**
| Day | Value |
|-----|-------|
| Sunday | `0` |
| Monday | `1` |
| Tuesday | `2` |
| Wednesday | `3` |
| Thursday | `4` |
| Friday | `5` |
| Saturday | `6` |

---

### Order Specification

Define how orders are executed when a rule fires.

#### Order Structure

```json
{
  "side": "long",
  "type": "market",
  "size": {
    "mode": "all",
    "value": 100
  }
}
```

#### Order Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `side` | string | | Position side: "long" or "short" |
| `type` | string | ✓ | Order type: "market" (more types may be supported) |
| `size` | object | | Order size specification |

#### Size Modes

##### 1. `"all"` - Use all available capital/position

**Entry (open):**
```json
{
  "mode": "all"
}
```
Uses all available capital to open position.

**Exit (close):**
```json
{
  "mode": "all"
}
```
Closes entire position.

---

##### 2. `"notional_quote"` - Fixed quote currency amount

```json
{
  "mode": "notional_quote",
  "value": 1000
}
```
Opens position worth 1000 units of quote currency (e.g., $1000 USD, 1000 USDC).

---

##### 3. `"percent"` - Percentage of capital/position

**Entry:**
```json
{
  "mode": "percent",
  "value": 50
}
```
Uses 50% of available capital.

**Exit:**
```json
{
  "mode": "percent",
  "value": 50
}
```
Closes 50% of position.

---

##### 4. `"notional_base"` - Fixed base asset quantity

```json
{
  "mode": "notional_base",
  "value": 0.5
}
```
Buys/sells 0.5 units of the base asset (e.g., 0.5 ETH).

---

#### Size Mode Examples

**Entry with $1000 fixed amount:**
```json
{
  "id": "rsi_entry",
  "intent": "open",
  "when": {
    "indicator": "rsi14",
    "op": "lt",
    "value": 30
  },
  "order": {
    "side": "long",
    "type": "market",
    "size": {
      "mode": "notional_quote",
      "value": 1000
    }
  }
}
```

**Partial exit (50% of position):**
```json
{
  "id": "partial_exit",
  "intent": "close",
  "when": {
    "profit": {
      "mode": "percent",
      "value": 5.0
    }
  },
  "order": {
    "type": "market",
    "size": {
      "mode": "percent",
      "value": 50
    }
  }
}
```

**Full exit (close entire position):**
```json
{
  "id": "full_exit",
  "intent": "close",
  "when": {
    "indicator": "rsi14",
    "op": "gt",
    "value": 70
  },
  "order": {
    "type": "market",
    "size": {
      "mode": "all"
    }
  }
}
```

**Fixed quantity (always buy 0.1 ETH):**
```json
{
  "id": "fixed_qty_entry",
  "intent": "open",
  "when": {
    "indicator": "sma20",
    "op": "crosses_above",
    "other": "sma50"
  },
  "order": {
    "side": "long",
    "type": "market",
    "size": {
      "mode": "notional_base",
      "value": 0.1
    }
  }
}
```

For more examples, see `examples/size-modes/` directory.

---

### Pyramiding (Scale-In)

Add to winning positions by allowing multiple entries:

```json
{
  "pyramiding": {
    "enabled": true,
    "max_legs": 5
  }
}
```

**Fields:**
- `enabled`: true/false
- `max_legs`: Maximum number of position entries allowed

**Example:**
```json
{
  "id": "scale_in_buy",
  "intent": "open",
  "when": {
    "indicator": "rsi14",
    "op": "lt",
    "value": 30
  },
  "order": {
    "side": "long",
    "type": "market",
    "size": {
      "mode": "notional_quote",
      "value": 1000
    }
  },
  "pyramiding": {
    "enabled": true,
    "max_legs": 5
  }
}
```

---

## Risk Manager

The risk manager provides automatic position protection and trade management.

### Risk Manager Structure

```json
{
  "risk_manager": {
    "leverage": 25,
    "stop_loss": {...},
    "take_profit": {...},
    "trailing_stop": {...},
    "cooldown": {...},
    "per_bar_limits": [...]
  }
}
```

All fields are optional. If not specified or `enabled: false`, that feature is disabled.

#### Leverage

Specify the leverage multiplier for position sizing:

```json
{
  "risk_manager": {
    "leverage": 25
  }
}
```

**Fields:**
- `leverage` (number): Leverage multiplier (e.g., 25 = 25x leverage)

**Example:**
```json
{
  "name": "leveraged_strategy",
  "symbol": "ETH/USDC",
  "indicators": [...],
  "rules": [...],
  "risk_manager": {
    "leverage": 25
  }
}
```

Leverage amplifies both potential gains and losses. Use cautiously with appropriate risk management.

---

### Stop Loss

Automatically exit when loss reaches a threshold.

#### Percent-based Stop Loss

```json
{
  "stop_loss": {
    "enabled": true,
    "mode": "percent",
    "value": 5.0
  }
}
```

Exit when position loses 5%.

#### Absolute Value Stop Loss

```json
{
  "stop_loss": {
    "enabled": true,
    "mode": "absolute",
    "value": 100.0
  }
}
```

Exit when position loses $100 (in quote currency). The loss is calculated as:
- `position_value = quantity × entry_price`
- `current_value = quantity × current_price`
- `loss = position_value - current_value`

When `loss >= value`, the stop loss triggers.

**Use Cases:**
- Fixed risk per trade regardless of position size
- Dollar-based risk management
- Consistent loss limits across different position sizes

#### ATR-based Stop Loss

```json
{
  "stop_loss": {
    "enabled": true,
    "mode": "atr",
    "value": 1.5,
    "atr_indicator": "atr14"
  }
}
```

**Fields:**
- `mode`: "atr"
- `value`: Multiplier for ATR value (1.5 = 1.5x ATR)
- `atr_indicator`: Name of the ATR indicator to use (default: "atr")

Exit when loss exceeds 1.5 × ATR from entry price.

#### Disabled Stop Loss

```json
{
  "stop_loss": {
    "enabled": false
  }
}
```

---

### Take Profit

Automatically exit when profit reaches a target.

#### Percent-based Take Profit

```json
{
  "take_profit": {
    "enabled": true,
    "mode": "percent",
    "value": 10.0
  }
}
```

Exit when position gains 10%.

#### Absolute Value Take Profit

```json
{
  "take_profit": {
    "enabled": true,
    "mode": "absolute",
    "value": 200.0
  }
}
```

Exit when position profits $200 (in quote currency). The profit is calculated as:
- `position_value = quantity × entry_price`
- `current_value = quantity × current_price`
- `profit = current_value - position_value`

When `profit >= value`, the take profit triggers.

**Use Cases:**
- Fixed profit target per trade
- Dollar-based profit goals
- Consistent profit targets across different position sizes

#### ATR-based Take Profit

```json
{
  "take_profit": {
    "enabled": true,
    "mode": "atr",
    "value": 2.5,
    "atr_indicator": "atr14"
  }
}
```

Exit when profit exceeds 2.5 × ATR from entry price.

---

### Trailing Stop Loss

Lock in profits by moving stop loss as position becomes profitable.

```json
{
  "trailing_stop": {
    "enabled": true,
    "start_mode": "atr",
    "start_value": 1.0,
    "distance_mode": "breakeven",
    "distance_value": 0.0,
    "atr_indicator": "atr14"
  }
}
```

#### Trailing Stop Fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable trailing stop |
| `start_mode` | string | When to activate: "atr" or "percent" |
| `start_value` | number | Activation threshold (e.g., 1.0 = profit ≥ 1×ATR) |
| `distance_mode` | string | How to trail: "breakeven", "atr", or "percent" |
| `distance_value` | number | Trail distance (0.0 for breakeven) |
| `atr_indicator` | string | ATR indicator name (default: "atr") |

#### Trailing Stop Modes

**1. Breakeven Trailing Stop**
```json
{
  "trailing_stop": {
    "enabled": true,
    "start_mode": "percent",
    "start_value": 5.0,
    "distance_mode": "breakeven",
    "distance_value": 0.0
  }
}
```
When profit ≥ 5%, move stop to breakeven (entry price).

**2. ATR-based Trailing Stop**
```json
{
  "trailing_stop": {
    "enabled": true,
    "start_mode": "atr",
    "start_value": 1.0,
    "distance_mode": "atr",
    "distance_value": 0.5,
    "atr_indicator": "atr14"
  }
}
```
When profit ≥ 1×ATR, trail stop at 0.5×ATR below current price.

**3. Percent-based Trailing Stop**
```json
{
  "trailing_stop": {
    "enabled": true,
    "start_mode": "percent",
    "start_value": 10.0,
    "distance_mode": "percent",
    "distance_value": 3.0
  }
}
```
When profit ≥ 10%, trail stop at 3% below current price.

---

### Cooldown

Prevent rapid re-entry after closing a position.

```json
{
  "cooldown": {
    "entry_secs": 300
  }
}
```

Wait 300 seconds (5 minutes) before allowing new entry after position close.

**Disable cooldown:**
```json
{
  "cooldown": {
    "entry_secs": 0
  }
}
```

---

### Per-Bar Limits

Limit the number of trades allowed within specific timeframes.

```json
{
  "per_bar_limits": [
    {
      "timeframe": "M1",
      "max_trades": 1
    },
    {
      "timeframe": "M5",
      "max_trades": 3
    },
    {
      "timeframe": "H1",
      "max_trades": 10
    }
  ]
}
```

**Supported Timeframes:**
- `"M1"`: 1 minute
- `"M5"`: 5 minutes
- `"M15"`: 15 minutes
- `"M30"`: 30 minutes
- `"H1"`: 1 hour
- `"H4"`: 4 hours
- `"D1"`: 1 day

**Example:** Maximum 1 trade per 1-minute bar, 3 trades per 5-minute bar.

**Enforcement Logic:**

Per-bar limits enforce a logical AND across all configured timeframes. A trade is only allowed if it satisfies **ALL** configured limits. This prevents overtrading across multiple time scales simultaneously.

**Example Behavior:**

With the configuration above:
- If you've already placed 1 trade in the current minute, a second attempt in the same minute will be rejected (even if M5 and H1 limits aren't exceeded)
- If you've placed 3 trades in the current 5-minute window, the next trade will be rejected until a new 5-minute bar starts
- You can place at most 10 trades per hour regardless of minute/5-minute distribution

**Use Cases:**

```json
// Conservative: Prevent rapid trading
{
  "per_bar_limits": [
    { "timeframe": "M1", "max_trades": 1 },
    { "timeframe": "H1", "max_trades": 5 }
  ]
}

// High-frequency with guardrails
{
  "per_bar_limits": [
    { "timeframe": "M1", "max_trades": 3 },
    { "timeframe": "M5", "max_trades": 10 },
    { "timeframe": "H1", "max_trades": 50 }
  ]
}

// Single timeframe (simplest)
{
  "per_bar_limits": [
    { "timeframe": "M15", "max_trades": 1 }
  ]
}
```


---

## Best Practices

### 1. Unique Names
- Use unique names for all indicators and rules
- Follow consistent naming conventions (e.g., `rsi14`, `sma20`, `ohlc_m1`)

### 2. Timeframes
- Always define OHLC indicators explicitly for each timeframe
- Specify timeframes for all indicators
- Higher timeframes require more warmup data

### 3. Risk Management
- Always use stop losses to protect capital
- Consider using ATR-based stops for volatility-adjusted risk
- Use per-bar limits to prevent overtrading

### 4. Testing
- Start with simple strategies and test thoroughly
- Use backtesting to validate strategy performance
- Monitor strategy behavior in different market conditions

### 5. Pyramiding
- Use cautiously as it increases position size
- Set reasonable `max_legs` to control risk
- Combine with proper stop losses

---

## Troubleshooting

### Common Errors

**1. Unknown indicator type**
- Check spelling of `type` field
- Refer to [Supported Indicators](#supported-indicators)

**2. Missing required parameters**
- Ensure `period` is specified for simple indicators
- Check `params` object for complex indicators like MACD

**3. Invalid operator**
- Use lowercase operators: `"lt"`, `"gt"`, `"crosses_above"`
- Check [Operators](#1-simple-indicator-comparison)

**4. Indicator not found in rules**
- Verify indicator `name` matches exactly in rules
- Check for typos (case-sensitive)

**5. Invalid timeframe**
- Use supported timeframes: M1, M5, M15, M30, H1, H4, D1
- Ensure consistent formatting

---

## Indicator Output Reference

Quick reference for accessing indicator outputs in rules:

### Traditional Technical Indicators

| Indicator Type | Output Names | Format Options |
|----------------|--------------|----------------|
| RSI | `rsi14` | Single value |
| SMA | `sma20` | Single value |
| EMA | `ema50` | Single value |
| MACD | `macd_macd`, `macd_signal`, `macd_histogram` | `macd.macd`, `macd.signal`, `macd.histogram` |
| StochRSI | `stochrsi_k`, `stochrsi_d` | Single format |
| Stochastic | `stoch_k`, `stoch_d` | `stoch.k`, `stoch.d` |
| Bollinger Bands | `bb_upper`, `bb_middle`, `bb_lower` | `bb.upper`, `bb.middle`, `bb.lower` |
| ATR | `atr14` | Single value |
| ADX | `adx14_adx`, `adx14_plus_di`, `adx14_minus_di` | `adx14.adx`, `adx14.plus_di`, `adx14.minus_di` |
| SuperTrend | `st_value`, `st_direction` | `st.value`, `st.direction` |
| Donchian Channel | `dc20_upper`, `dc20_lower`, `dc20_middle` | `dc20.upper`, `dc20.lower`, `dc20.middle` |
| Keltner Channel | `kc_upper`, `kc_middle`, `kc_lower` | `kc.upper`, `kc.middle`, `kc.lower` |
| Parabolic SAR | `sar_value`, `sar_direction` | `sar.value`, `sar.direction` |
| Ichimoku Cloud | `ich_tenkan`, `ich_kijun`, `ich_span_a`, `ich_span_b`, `ich_chikou` | `ich.tenkan`, `ich.kijun`, `ich.span_a`, `ich.span_b`, `ich.chikou` |
| Heikin-Ashi | `ha_open`, `ha_high`, `ha_low`, `ha_close` | `ha.open`, `ha.high`, `ha.low`, `ha.close` |
| Linear Regression | `lr14_slope`, `lr14_value` | `lr14.slope`, `lr14.value` |
| CCI | `cci20` | Single value |
| Z-Score | `z20` | Single value |

### Formation Indicators

| Indicator Type | Output Fields | Description |
|----------------|---------------|-------------|
| **Renko** | `renko_10.brick_high` | High price of current brick |
| | `renko_10.brick_low` | Low price of current brick |
| | `renko_10.direction` | 1 (up), -1 (down), 0 (none) |
| | `renko_10.brick_count` | Total bricks formed |
| | `renko_10.is_new_brick` | 1 if new brick just formed |
| | `renko_10.brick_size` | Configured brick size |
| **RenkoATR** | Same as Renko | ATR-adaptive brick sizing |
| **OHLC** | `ohlc_m5.open` or `ohlc_m5_open` | Opening price of candle |
| | `ohlc_m5.high` or `ohlc_m5_high` | High price of candle |
| | `ohlc_m5.low` or `ohlc_m5_low` | Low price of candle |
| | `ohlc_m5.close` or `ohlc_m5_close` | Closing price of candle |
| | `ohlc_m5.volume` or `ohlc_m5_volume` | Volume of candle |

**Note:** All formation indicators support **both dot notation** (`.`) and **underscore notation** (`_`) interchangeably. For example, `ohlc_m5.close` and `ohlc_m5_close` are equivalent. Lookback also works: `ohlc_m5.close[1]` or `ohlc_m5_close[1]`.

---


## Feature Summary

### Supported Features

✅ **Indicators**: RSI, SMA, EMA, MACD, StochRSI, Stochastic, Bollinger Bands, ATR, Renko, RenkoATR, OHLC  
✅ **Expressions**: Dynamic calculations with operators: add, sub, mul, div, abs, neg, average, min, max, rolling_max, rolling_min  
✅ **Conditions**: Simple comparison, compound (all/any), crosses, profit-based, position age, expressions  
✅ **Dynamic Sizing**: Expression-based position sizing for volatility-adjusted and momentum-based sizing  
✅ **Size Modes**: all, notional_quote, notional_base, percent  
✅ **Risk Management**: Stop loss, take profit, trailing stop, cooldown, per-bar limits  
✅ **Pyramiding**: Scale-in with max_legs configuration  
✅ **External Signals**: See [EXTERNAL_SIGNALS_API.md](EXTERNAL_SIGNALS_API.md) for AI/ML integration  
✅ **Multi-Timeframe**: Support for M1, M5, M15, M30, H1, H4, D1  
✅ **Lookback**: Historical bar access with `[N]` syntax (e.g., `ohlc_m5.high[1]`)  
✅ **Price Reference**: Use `"price"` for current market price  
✅ **Order Logging**: JSON order files with P&L tracking per trade  
✅ **State Persistence**: Redis and local file backends  

---

**Version:** 3.0  
**Last Updated:** April 2026
