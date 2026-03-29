# Strategy JSON API Reference

Complete guide to creating trading strategy JSON files for the Trading Rule Engine.

> Canonical OpenClaw strategy reference. The `strategy-reference` skill should load this file before answering strategy-schema questions or generating strategy JSON.
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
   - [Usage in Conditions](#usage-in-conditions)
   - [Usage in Position Sizing](#usage-in-position-sizing)
   - [Expression Examples](#expression-examples)
5. [Rules](#rules)
   - [Conditions](#rule-conditions)
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
8. [Deprecated Features](#deprecated-features)

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

| Field        | Type   | Description                                        |
| ------------ | ------ | -------------------------------------------------- |
| `name`       | string | Unique identifier for the strategy                 |
| `symbol`     | string | Trading pair symbol (e.g., "ETH/USDC", "BTC/USDC") |
| `indicators` | array  | List of technical indicators to calculate          |
| `rules`      | array  | List of trading rules (entry/exit conditions)      |

### Optional Fields

| Field          | Type   | Default | Description                   |
| -------------- | ------ | ------- | ----------------------------- |
| `risk_manager` | object | null    | Risk management configuration |

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

| Field       | Type   | Required | Description                                                        |
| ----------- | ------ | -------- | ------------------------------------------------------------------ |
| `type`      | string | ✓        | Indicator type (see [Supported Indicators](#supported-indicators)) |
| `name`      | string | ✓        | Unique name to reference this indicator in rules                   |
| `period`    | number | \*       | Period/length for the indicator (required for most)                |
| `timeframe` | string |          | Timeframe: "M1", "M5", "M15", "M30", "H1", "H4", "D1"              |
| `params`    | object |          | Additional parameters (varies by indicator type)                   |

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
- ❌ **DEPRECATED:** Don't use `"close"`, `"open"`, `"high"`, `"low"` directly (see [Deprecated Features](#deprecated-features))

---

## Expressions

Expressions enable **dynamic calculations** and **complex logic** in your trading rules. Instead of using static values, you can perform arithmetic operations on indicators, combine multiple indicators, and create sophisticated conditions and position sizing formulas.

### Expression Syntax

Expressions are defined using a structured JSON format that represents an Abstract Syntax Tree (AST). Each expression is an object with an operator type and operands.

**Basic Structure:**

```json
{
  "operator": "add|sub|mul|div|abs|neg|average|min|max",
  "operands": [...]
}
```

**Operand Types:**

- **Number**: `{"number": 42.5}`
- **Indicator**: `{"indicator": "rsi14"}`
- **Nested Expression**: Another expression object

### Operators

#### Arithmetic Operators

| Operator | Description    | Example                                                                                | Result     |
| -------- | -------------- | -------------------------------------------------------------------------------------- | ---------- |
| `add`    | Addition       | `{"operator": "add", "operands": [{"number": 100}, {"indicator": "rsi14"}]}`           | 100 + RSI  |
| `sub`    | Subtraction    | `{"operator": "sub", "operands": [{"indicator": "rsi14"}, {"indicator": "rsi14[1]"}]}` | RSI slope  |
| `mul`    | Multiplication | `{"operator": "mul", "operands": [{"number": 500}, {"indicator": "macd_histogram"}]}`  | 500 × MACD |
| `div`    | Division       | `{"operator": "div", "operands": [{"number": 1000}, {"indicator": "atr14"}]}`          | 1000 / ATR |

#### Unary Operators

| Operator | Description    | Example                                                              | Result   |
| -------- | -------------- | -------------------------------------------------------------------- | -------- |
| `abs`    | Absolute value | `{"operator": "abs", "operands": [{"indicator": "macd_histogram"}]}` | \|MACD\| |
| `neg`    | Negation       | `{"operator": "neg", "operands": [{"indicator": "rsi14"}]}`          | -RSI     |

#### Statistical Operators

| Operator  | Description      | Example                                                                                       | Result                    |
| --------- | ---------------- | --------------------------------------------------------------------------------------------- | ------------------------- |
| `average` | Mean of operands | `{"operator": "average", "operands": [{"indicator": "bb_upper"}, {"indicator": "bb_lower"}]}` | (BB_upper + BB_lower) / 2 |
| `min`     | Minimum value    | `{"operator": "min", "operands": [{"indicator": "price"}, {"number": 3000}]}`                 | min(price, 3000)          |
| `max`     | Maximum value    | `{"operator": "max", "operands": [{"indicator": "atr14"}, {"number": 5}]}`                    | max(ATR, 5)               |

### Usage in Conditions

Expressions can be used in rule conditions to create complex entry/exit logic.

**Example: RSI Slope Detection**

```json
{
  "id": "rsi_rising",
  "intent": "open",
  "when": {
    "left_expr": {
      "operator": "sub",
      "operands": [{ "indicator": "rsi14" }, { "indicator": "rsi14[1]" }]
    },
    "op": "gt",
    "right_value": 0
  }
}
```

**Example: Bollinger Band Compression**

```json
{
  "id": "bb_squeeze",
  "intent": "open",
  "when": {
    "left_expr": {
      "operator": "sub",
      "operands": [{ "indicator": "bb_upper" }, { "indicator": "bb_lower" }]
    },
    "op": "lt",
    "right_expr": {
      "operator": "average",
      "operands": [
        { "indicator": "bb_upper[1]" },
        { "indicator": "bb_lower[1]" },
        { "indicator": "bb_upper[2]" },
        { "indicator": "bb_lower[2]" }
      ]
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
        "operator": "div",
        "operands": [{ "number": 1000 }, { "indicator": "atr14" }]
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
        "operator": "mul",
        "operands": [
          { "number": 500 },
          {
            "operator": "abs",
            "operands": [{ "indicator": "macd_histogram" }]
          }
        ]
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
  "operator": "sub",
  "operands": [{ "indicator": "rsi14" }, { "indicator": "rsi14[1]" }]
}
```

**2. Dynamic Stop Distance (Multiple of ATR)**

```json
{
  "operator": "mul",
  "operands": [{ "indicator": "atr14" }, { "number": 2.0 }]
}
```

**3. Bollinger Band Width**

```json
{
  "operator": "sub",
  "operands": [{ "indicator": "bb_upper" }, { "indicator": "bb_lower" }]
}
```

**4. Normalized Indicator (0-1 Range)**

```json
{
  "operator": "div",
  "operands": [{ "indicator": "rsi14" }, { "number": 100 }]
}
```

**5. Combined Indicator Strength**

```json
{
  "operator": "average",
  "operands": [
    { "indicator": "rsi14" },
    { "indicator": "stoch_k" },
    { "indicator": "stochrsi" }
  ]
}
```

**6. Price Distance from Moving Average**

```json
{
  "operator": "sub",
  "operands": [{ "indicator": "price" }, { "indicator": "sma20" }]
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
      "operator": "div",
      "operands": [{ "number": 1000 }, { "indicator": "atr14" }]
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

| Field        | Type   | Required | Description                                        |
| ------------ | ------ | -------- | -------------------------------------------------- |
| `id`         | string | ✓        | Unique identifier for this rule                    |
| `intent`     | string | ✓        | "open" (enter position) or "close" (exit position) |
| `when`       | object | ✓        | Condition that triggers the rule                   |
| `order`      | object |          | Order specification (type and size)                |
| `pyramiding` | object |          | Pyramiding/scaling configuration                   |

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

**DEPRECATED:** The `close@M1[1]` syntax is deprecated. See [Deprecated Features](#deprecated-features).

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

````json
{
  "any": [
    {
      "indicator": "rsi14",
      "op": "gt",
      "value": 80
    },
    {
      "indicator": "stoch.≤)
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
````

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

| Field  | Type   | Required | Description                                        |
| ------ | ------ | -------- | -------------------------------------------------- |
| `side` | string |          | Position side: "long" or "short"                   |
| `type` | string | ✓        | Order type: "market" (more types may be supported) |
| `size` | object |          | Order size specification                           |

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

**Deprecated:** `"fixed_usd"` is deprecated but still supported as an alias for `"notional_quote"`.

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

**Deprecated:** `"fixed_asset"` and `"shares"` are deprecated but still supported as aliases for `"notional_base"`.

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

| Field            | Type    | Description                                       |
| ---------------- | ------- | ------------------------------------------------- |
| `enabled`        | boolean | Enable trailing stop                              |
| `start_mode`     | string  | When to activate: "atr" or "percent"              |
| `start_value`    | number  | Activation threshold (e.g., 1.0 = profit ≥ 1×ATR) |
| `distance_mode`  | string  | How to trail: "breakeven", "atr", or "percent"    |
| `distance_value` | number  | Trail distance (0.0 for breakeven)                |
| `atr_indicator`  | string  | ATR indicator name (default: "atr")               |

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
    { "timeframe": "M1", "mak",
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

```jsonx_trades": 3 },
    { "timeframe": "M5", "max_trades": 10 },

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
- ` { "timeframe": "H1", "max_trades": 50 }
  ]
  }

// Single timeframe (simplest)
{
"per_bar_limits": [
{ "timeframe": "M15", "max_trades": 1 }
]
}

````

For detailed examples, see `examples/PER_BAR_LIMITS_README.md` and `examples/per_bar_limits_demo.rs`.

---

## Complete Examples

### Example 1: Simple RSI Strategy

```json
{
  "name": "simple_rsi_strategy",
  "symbol": "ETH/USDC",
  "indicators": [
    {
      "type": "rsi",
      "name": "rsi14",
      "period": 14,
      "timeframe": "M1"
    }
  ],
  "rules": [
    {
      "id": "buy_oversold",
      "intent": "open",
      "when": {
        "indicator": "rsi14",
        "op": "lt",
        "value": 30
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    },
    {
      "id": "sell_overbought",
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
  ],
  "risk_manager": {
    "stop_loss": {
      "enabled": true,
      "mode": "percent",
      "value": 5.0
    },
    "take_profit": {
      "enabled": true,
      "mode": "percent",
      "value": 10.0
    }
  }
}
````

---

### Example 2: MACD Crossover with Multiple Conditions

```json
{
  "name": "macd_crossover_strategy",
  "symbol": "ETH/USDC",
  "indicators": [
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
  ],
  "rules": [
    {
      "id": "bullish_cross",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "macd.macd",
            "op": "crosses_above",
            "other": "macd.signal"
          },
          {
            "indicator": "macd.histogram",
            "op": "gt",
            "value": 0
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    },
    {
      "id": "bearish_cross",
      "intent": "close",
      "when": {
        "all": [
          {
            "indicator": "macd.macd",
            "op": "crosses_below",
            "other": "macd.signal"
          },
          {
            "indicator": "macd.histogram",
            "op": "lt",
            "value": 0
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    }
  ]
}
```

---

### Example 3: Trend Following with ATR-based Risk

````json
{
  "name": "trend_following_atr",
  "symbol": "ETH/USDC",
  "indicators": [
    {
      "type": "ema",
      "name": "ema20",
      "period": 20,
      "timeframe": "M1"
    },
    {
      "type": "ema",
      "name": "ema50",
      "period": 50,
      "timeframe": "M1"
    },
    {
      "type": "atr",
      "name": "atr14",
      "timeframe": "M1",
      "params": {
        "period": 14
      }
    }
  ],
  "rules": [
    {
      "id": "golden_cross",
      "intent": "open",
      "when": {
        "indicator": "ema20",
        "op": "crosses_above",
        "other": "ema50"
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "percent",
          "value": 100
        }
      }
    },
    {
      "id": "death_cross",
      "intent": "close",
      "when": {
        "indicator": "ema20",


### Example 5: Scale-In Strategy with RSI

```json
{
  "name": "scale_in_rsi_strategy",
  "symbol": "ETH/USDC",
  "indicators": [
    {
      "type": "rsi",
      "name": "rsi14",
      "period": 14,
      "timeframe": "M1"
    },
    {
      "type": "sm: "M1"
    }
  ],
  "rules": [
    {
      "id": "scale_in_buy",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "rsi14",
            "op": "lt",
            "value": 30
          },
          {
            "indicator": "price",
            "op": "lt",
            "other": "sma20"
          }
        ]
      },
      "order": {
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
    },
    {
      "id": "exit_all",
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
  ],
  "risk_manager": {
    "stop_loss": {
      "enabled": true,
      "mode": "percent",
      "value": 10.0
    },
    "take_profit": {
      "enabled": true,
      "mode": "percent",
      "value": 10.0
    }
  }
}
````

---

### Example 6: Multi-Timeframe Strategy

```json
{
  "name": "multi_timeframe_strategy",
  "symbol": "ETH/USDC",
  "indicators": [
    {
      "type": "sma",
      "name": "sma20_m1",
      "period": 20,
      "timeframe": "M1"
    },
    {
      "type": "sma",
      "name": "sma50_m5",
      "period": 50,
      "timeframe": "M5"
    },
    {
      "type": "rsi",
      "name": "rsi14_m15",
      "period": 14,
      "timeframe": "M15"
    }
  ],
  "rules": [
    {
      "id": "multi_tf_buy",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "price",
            "op": "gt",
            "other": "sma20_m1"
          },
          {
            "indicator": "price",
            "op": "gt",
            "other": "sma50_m5"
          },
          {
            "indicator": "rsi14_m15",
            "op": "gt",
            "value": 50
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    },
    {
      "id": "multi_tf_sell",
      "intent": "close",
      "when": {
        "indicator": "rsi14_m15",
        "op": "lt",
        "value": 40
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    }
  ],
  "risk_manager": {
    "per_bar_limits": [
      {
        "timeframe": "M1",
        "max_trades": 1
      }
    ]
  }
}
```

---

### Example 7: External Signal Strategy (AI/ML)

````json
{
  "name": "ai_signal_strategy",
  "symbol": "BTC/USDC",
  "indicators": [
    {
      "type": "rsi",
      "name": "rsi14",
      "period": 14,
      "timeframe": "M1"
    }
  ],
  "rules": [
    {
      "id": "ai_buy_signal",
      "intent": "open",
      "when": {
        "all": [
          {
            "signal_name"a",
      "name": "sma20",
      "period": 20,
      "timeframe"     "op": "crossute",
    }
  }
}
```. This provides consistent dollar-based risk/reward ratios.

---

This strategy risks $250 and targets $500 profit on each trade, regardless of the exact position size or BTC price   "value": 250.0
    },
    "take_profit": {
      "enabled": true,: "AI_SIGNAL",
            "op": "==",
            "value": "BUY
      "mode": "absolute",
      "value": 500.0
   es_below",
        "other": "ema50"
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
          "mode": "all""
          },
          {
            "signal_name": "AI_CONFID
        }
      }
    }
  ],
  "risk_manager": {
    "stop_loss": {
      "enabled": true,
      "mode": "absol }
      }
    }
  ],
  "risk_manager": {
    "stop_loss": {
      "order": {
        "type": "market",
        "size": {
         "enabled": true,
      "mode": "atr",
      "value": 1.5,
      "atr_indicator": "atr14"
    },
    "take_profit": {
      "enabled": true,
      "mode": "atr",
      "value": 2.5,: "rsi14",
        "op": "gt",
        "value": 60ENCE",
            "op": ">=",
            "value": "0.8"
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "notional_quote",
          "value": 2000
        }
      }
    },
    {
      "id": "ai_sell_signal",
      "intent": "close",
      "when": {
        "all": [
          {
            "signal_name": "AI_SIGNAL",
            "op": "==",
            "value": "SELL"
          },
          {
            "signal_name": "AI_CONFIDENCE",
            "op": ">=",
            "value": "0.8"
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    }
  ]
}
````

---

### Example 8: Bollinger Bands Breakout

```json
{
  "name": "bollinger_breakout",
  "symbol": "ETH/USDC",
  "indicators": [
    {
      "type": "bollinger",
      "name": "bb",
      "timeframe": "M1",
      "params": {
        "period": 20,
        "std_dev": 2.0
      }
    },
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
  ],
  "rules": [
    {
      "id": "bb_lower_bounce",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "price",
            "op": "lt",
            "other": "bb.lower"
          },
          {
            "indicator": "stochrsi_k",
            "op": "lt",
            "value": 20
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    },
    {
      "id": "bb_upper_sell",
      "intent": "close",
      "when": {
        "all": [
          {
            "indicator": "price",
            "op": "gt",
            "other": "bb.upper"
          },
          {
            "indicator": "stochrsi_k",
            "op": "gt",
            "value": 80
          }
        ]
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    }
  ],
  "risk_manager": {
    "per_bar_limits": [
      {
        "timeframe": "M1",
        "max_trades": 1
      }
    ]
  }
}
```

---

### Example 9: Timed Exit Strategy

```json
{
  "name": "timed_exit_strategy",
  "symbol": "BTC/USDC",
  "indicators": [
    {
      "type": "rsi",
      "name": "rsi14",
      "period": 14,
      "timeframe": "M1"
    }
  ],
  "rules": [
    {
      "id": "rsi_entry",
      "intent": "open",
      "when": {
        "indicator": "rsi14",
        "op": "lt",
        "value": 30
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "notional_quote",
          "value": 1000
        }
      }
    },
    {
      "id": "timed_exit_5min",
      "intent": "close",
      "when": {
        "position_age_secs": 300
      },
      "order": {
        "type": "market",
        "size": {
          "mode": "all"
        }
      }
    },
    {
      "id": "rsi_exit",
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

      },

      "atr_indicator": "atr14"
    },
    "tra}
      }
    }
  ],
  "risk_manager": {
    "cooldown": {
     iling_stop": {
      "enabled": true,
      "start_mode": "atr",
      "start_value": 1.0,
      "distance_mode": "breakeven",
      "distance_value": 0.0,
      "atr_indicator": "atr14"
    }
  }
}
```

---

### Example 4: Fixed Dollar Risk with Absolute Values

```json
{
  "name": "fixedt",
      "intent": "close",
      "when": {
        "indicator"_risk_strategy",
  "symbol": "BTC/USDC",
  "indicators": [
    {
      "type": "rsi",
      "name": "rsi14",
      "period": 14,
      "   "value": 5000
        }
      }
    },
    {
      "id": "exitimeframe": "M1"
    },
    {
      "type": "sma",
      "name": "sma50",
      "period": 50,
      "timeframe": "M1"
    }
  ],
  "rules": [",
        "size": {
          "mode": "notional_quote",

    {
      "id": "entry",
      "intent": "open",
      "when": {
        "all": [
          {
            "indicator": "rsi14",
            "op": "lt",
            "value": 40
          },
          {
            "indicator": "price",
            "op": "gt",
            "other": "sma50"
          }
        ]
      },
      "entry_secs": 60
    }
  }
}
```

---

## Deprecated Features

This section documents features that are still supported for bac "order": {
"type": "market"le"`: Less than or equal (kward compatibility but are **deprecated** and should be avoided in new strategies.

### 1. OHLC Component Names Without Indicators (DEPRECATED)

**Deprecated Usage:**

```json
{
  "indicator": "close",
  "op": "gt",
  "other": "sma20"
}
```

**Problem:** Using `"close"`, `"open"`, `"high"`, `"low"` directly as indicator names without defining an OHLC indicator makes strategies less explicit and harder to understand. It also prevents accessing historical price data with lookback.

**Important:** This deprecation applies ONLY to `"close"`, `"open"`, `"high"`, `"low"`. The `"price"` indicator is **NOT deprecated** and is the recommended way to reference the current live market price. See [Current Price Reference](#current-price-reference) for details.

**Recommended Replacement:**

For bar/candle-based strategies with lookback, define an OHLC indicator:

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
      "id": "close_above_sma",
      "intent": "open",
      "when": {
        "indicator": "ohlc_m1.close",
        "op": "gt",
        "other": "sma20"
      }
    }
  ]
}
```

For simple current price comparisons, use `"price"`:

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

**Benefits of OHLC Indicators:**

- Explicit timeframe specification
- Access to all OHLC components (open, high, low, close, volume)
- Full lookback support: `ohlc_m1.close[1]`, `ohlc_m1.high[2]`, etc.
- Consistent with other indicator usage patterns

**Benefits of "price" Indicator:**

- Simple current market price reference
- No indicator definition required
- Clear intent for live price comparisons

---

### 2. @Timeframe Lookback Syntax (DEPRECATED)

**Deprecated Usage:**

```json
{
  "indicator": "close@M1",
  "op": "gt",
  "other": "high@M5[1]"
}
```

**Problem:** The `indicator@TF[N]` syntax is inconsistent with how other indicators work and makes strategies harder to read. It bypasses the indicator system, preventing proper tracking and debugging.

**Recommended Replacement:**

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
    }
  ],
  "rules": [
    {
      "id": "multi_tf_breakout",
      "intent": "open",
      "when": {
        "indicator": "ohlc_m1.close",
        "op": "gt",
        "other": "ohlc_m5.high[1]"
      }
    }
  ]
}
```

**Benefits:**

- Indicators are explicitly declared and visible in the strategy configuration
- Consistent dot/underscore notation for all components
- Better error messages when indicators are not defined
- Easier to debug and understand strategy logic

---

### 3. profit_pct Condition (DEPRECATED)

**Deprecated Usage:**

````json
{
  "when": {
    "profit_pct": 10.0
  }Migration Guide

When updating old strategies to use the recommended patterns:

1. **Add OHLC"ohlc",
     "name": "ohlc_m1",
     "period": 1,
     "timeframe": "M1",
     "params": {}
   }
   ```"`, `"ohlc_m1.open"`, etc.

3. **Replace @timeframe syntax** (`"high@M5[1]"`) with OHLC indicator references (`"ohlc_m5.high[1]"`)

4. **Update profit_pct** to use the new `profit` condition format

5. **Test thoroughly** after migration to ensure behavior remains unchanged

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

### Formation Indicators

| Indicator Type | Output Fields | Description |
|----------------|---------------|-------------|
| **Renko** | `renko_10.brick_high` | High price of current brick |
| | `renko_10.brick_low` | Low price of current brick |
| | `renko_10.direction` | 1 (up), -1 (down), 0 (none) |
| | `renko_10.brick_count` | Total

2. **Replace direct price references** (`"close"`, `"open"`, etc.) with `"ohlc_m1.close indicators** to your `indicators` array for each timeframe you need:
   ```json
   {
     "type":
}
``` 10.0fit Condition](#7-profit-condition) for full details.

---

### , bricks formed |
| | `renko_10.is_new_brick` | 1 if new brick ju
  Currency selection (quote or asset) for absolute mode

See [Pro     "op": "ge"ion supports:
- Multiple comparison operators (`gt`, `ge`, `lt`, `le`, `eq`, `ne`)
- Both percentage and absolute profit modes
-
    }
  }
}
````

st formed |
| | `renko_10.brick_size` | Configured brick size |

The new `profit` condit

**Problem:** Limited to percentage-based profit checks with only `>=` comparison.

**Recommended Replacement:**

```json
{
  "when": {
    "profit": {
| **RenkoATR** | Same as Renko | ATR-adaptive brick sizing |
| *      "mode": "percent",
   *OHLC** | `ohlc_m5.open` or `ohlc_m5_open` | Opening price of candle |
| | `ohlc_m5.high` or `ohlc_m5_high` | High price of candle |
| | `ohlc_m5.low` or `ohlc_m5_low` | Low price of candle |
| | `ohlc_m5.close` or `ohlc_m5_close` | Closing price of candle |
| | `ohlc_m5.volume` or `ohlc_m5_volume` | Volume of candle |

**Note:** All formation indicators support **both dot notation** (`.`) and **underscore notation** (`_`) interchangeably. For example, `ohlc_m5.close` and `ohlc_m5_close` are equivalent. Lookback also works: `ohlc_m5.close[1]` or `ohlc_m5_close[1]`.

### Built-in Price Values (DEPRECATED)

**These are deprecated. Use OHLC indicators instead.**

| Name | Description | Replacement |
|------|-------------|-------------|
| `close` | Current closing price | Define `ohlc_m1` and use `ohlc_m1.close` |
| `open` | Current opening price | Define `ohlc_m1` and use `ohlc_m1.open` |
| `high` | Current high price | Define `ohlc_m1` and use `ohlc_m1.high` |
| `low` | Current low price | Define `ohlc_m1` and use `ohlc_m1.low` |

See [Deprecated Features](#deprecated-features) for migration guide.

---

## Additional Resources

### Documentation
- **Renko & OHLC**: See `examples/RENKO_OHLC_README.md` for detailed Renko and OHLC documentation
- **Size Modes**: See `examples/size-modes/README.md` for position sizing strategies
- **External Signals**: See [EXTERNAL_SIGNALS_API.md](EXTERNAL_SIGNALS_API.md) for AI integration and external data sources
- **Per-Bar Limits**: See `examples/PER_BAR_LIMITS_README.md` for rate limiting examples
- **Profit Conditions**: See `examples/PROFIT_CONDITION_README.md` for profit-based exits

### Example Strategies
- **Expressions**: `examples/expressions/` - Dynamic calculations and complex logic
- **Indicators**: `examples/indicators-showcase/` - Showcase of all indicator types
- **Notifications**: `examples/notifs/` - Production notification strategies
- **Scale-In**: `examples/scale-in/` - Pyramiding and accumulation strategies
- **Size Modes**: `examples/size-modes/` - Different position sizing approaches
- **OHLC Bars**: `examples/ohlc-bars/` - Multi-timeframe bar-based strategies
- **Renko**: `examples/renko/` - Renko brick trading strategies
- **Risk Management**: `examples/risk/` - Stop loss and take profit examples
- **External Signals**: See [EXTERNAL_SIGNALS_API.md](EXTERNAL_SIGNALS_API.md)

### Source Code
- **Strategy Parser**: `src/dsl_json.rs` and `src/strategy_parser.rs`
- **Indicator Adapter**: `src/indicator_adapter.rs`
- **Indicator Parameters**: `src/indicator_params.rs`
- **Engine Processor**: `src/engine_processor.rs`

### Testing & Running
- **Production Mode**: `cargo run --example all_strategies_prod -- examples/input/ticks.json console`
- **With Redis Backend**: `cargo run --example all_strategies_prod -- examples/input/ticks.json both:log.txt --backend=redis://127.0.0.1:6379`
- **Individual Strategy**: Most examples have their own dedicated `.rs` files

---

## Feature Summary

### Supported Features

✅ **Indicators**: RSI, SMA, EMA, MACD, StochRSI, Stochastic, Bollinger Bands, ATR, Renko, RenkoATR, OHLC
✅ **Expressions**: Dynamic calculations with 10 operators (add, sub, mul, div, abs, neg, average, min, max)
✅ **Conditions**: Simple comparison, compound (all/any), crosses, profit-based, position age, expressions
✅ **Dynamic Sizing**: Expression-based position sizing for volatility-adjusted and momentum-based sizing
✅ **Size Modes**: all, notional_quote, notional_base, percent (deprecated: fixed_usd, fixed_asset, shares)
✅ **Risk Management**: Stop loss, take profit, trailing stop, cooldown, per-bar limits
✅ **Pyramiding**: Scale-in with max_legs configuration
✅ **External Signals**: See [EXTERNAL_SIGNALS_API.md](EXTERNAL_SIGNALS_API.md) for AI/ML integration
✅ **Multi-Timeframe**: Support for M1, M5, M15, M30, H1, H4, D1
✅ **Lookback**: Historical bar access with `[N]` syntax (e.g., `ohlc_m5.high[1]`)
✅ **Price Reference**: Use `"price"` for current market price
✅ **Order Logging**: JSON order files with P&L tracking per trade
✅ **State Persistence**: Redis and local file backends

---

**Version:** 2.0
**Last Updated:** December 2025   "value":
```
