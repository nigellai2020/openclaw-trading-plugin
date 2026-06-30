import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeStrategyRuleWhens } from "../src/utils/strategy-normalization.js";

test("normalizeStrategyRuleWhens parses CDATA-wrapped JSON condition strings", () => {
  const strategy = {
    name: "ema_short_term_9_21",
    symbol: "SOL/USDC",
    indicators: [],
    rules: [
      {
        id: "ema_cross_long",
        intent: "open",
        when: '<![CDATA[{"indicator":"ema9[1]","op":"crosses_above","other":"ema21[1]"}]]></when>',
      },
    ],
  };

  const normalized = normalizeStrategyRuleWhens(strategy);

  assert.deepEqual(normalized.rules[0]?.when, {
    indicator: "ema9[1]",
    op: "crosses_above",
    other: "ema21[1]",
  });
});

test("normalizeStrategyRuleWhens parses simple XML-ish condition tags", () => {
  const strategy = {
    name: "ema_short_term_9_21",
    symbol: "SOL/USDC",
    indicators: [],
    rules: [
      {
        id: "ema_cross_short",
        intent: "open",
        when: "<indicator>ema9[1]</indicator><op>crosses_below</op><other>ema21[1]</other>",
      },
    ],
  };

  const normalized = normalizeStrategyRuleWhens(strategy);

  assert.deepEqual(normalized.rules[0]?.when, {
    indicator: "ema9[1]",
    op: "crosses_below",
    other: "ema21[1]",
  });
});

test("normalizeStrategyRuleWhens leaves valid object conditions untouched", () => {
  const when = { indicator: "ema9[1]", op: "crosses_above", other: "ema21[1]" };
  const strategy = {
    name: "ema_short_term_9_21",
    symbol: "SOL/USDC",
    indicators: [],
    rules: [
      {
        id: "ema_cross_long",
        intent: "open",
        when,
      },
    ],
  };

  const normalized = normalizeStrategyRuleWhens(strategy);

  assert.equal(normalized.rules[0]?.when, when);
});