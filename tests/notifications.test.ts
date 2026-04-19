import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatBacktestSummary } from "../src/utils/notifications.js";

const TG_LIMIT = 4096;

test("formatBacktestSummary ranks winners first, no-trades last, collapses no-trade periods", () => {
  const event = {
    scheduled_at: "2026-04-19",
    agents: [
      {
        agent_id: 2,
        agent_name: "LossAgent",
        periods: [
          { period: "1d", total_return: -0.05, max_drawdown: 0.2, win_rate: 0.3, has_trades: true },
          { period: "7d", total_return: -0.1, max_drawdown: 0.3, win_rate: 0.25, has_trades: true },
          { period: "30d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
          { period: "180d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
        ],
      },
      {
        agent_id: 3,
        agent_name: "QuietAgent",
        periods: [
          { period: "1d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
          { period: "7d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
          { period: "30d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
          { period: "180d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
        ],
      },
      {
        agent_id: 1,
        agent_name: "WinAgent",
        periods: [
          { period: "1d", total_return: 0.12, max_drawdown: 0.04, win_rate: 0.7, has_trades: true },
          { period: "7d", total_return: 0.25, max_drawdown: 0.08, win_rate: 0.65, has_trades: true },
          { period: "30d", total_return: 0.5, max_drawdown: 0.12, win_rate: 0.6, has_trades: true },
          { period: "180d", total_return: null, max_drawdown: null, win_rate: null, has_trades: false },
        ],
      },
    ],
  };

  const out = formatBacktestSummary(event);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  const msg = out[0];
  assert.ok(msg.startsWith("<b>[Auto Backtest Summary] 2026-04-19</b>"));

  const winIdx = msg.indexOf("<b>WinAgent</b>:");
  const lossIdx = msg.indexOf("<b>LossAgent</b>:");
  const quietIdx = msg.indexOf("<b>QuietAgent</b>:");
  assert.ok(winIdx > 0 && lossIdx > winIdx, "winner should come before loser");
  assert.ok(quietIdx > lossIdx, "no-trade agent should come last");

  assert.ok(msg.includes("<b>180d</b>: no trade"));
  assert.ok(msg.includes("<b>30d</b>: no trade"));
  assert.ok(msg.includes("<b>1d</b>: no trade"));
  assert.ok(!msg.includes("no trades ("));

  assert.ok(msg.includes("Ret 12%"));
  assert.ok(msg.includes("DD 4%"));
  assert.ok(msg.includes("WR 70%"));

  assert.ok(msg.length <= TG_LIMIT);
});

test("formatBacktestSummary chunks across TG_LIMIT with many agents", () => {
  const agents = Array.from({ length: 50 }, (_, i) => ({
    agent_id: i,
    agent_name: `Agent${String(i).padStart(3, "0")}`,
    periods: [
      { period: "1d", total_return: 0.01 * i, max_drawdown: 0.05, win_rate: 0.5, has_trades: true },
      { period: "7d", total_return: 0.02 * i, max_drawdown: 0.06, win_rate: 0.55, has_trades: true },
      { period: "30d", total_return: 0.03 * i, max_drawdown: 0.07, win_rate: 0.6, has_trades: true },
      { period: "180d", total_return: 0.04 * i, max_drawdown: 0.08, win_rate: 0.65, has_trades: true },
    ],
  }));
  const out = formatBacktestSummary({ scheduled_at: "2026-04-19", agents });
  assert.ok(out.length > 1, "50 agents should chunk into multiple messages");
  for (const msg of out) {
    assert.ok(msg.length <= TG_LIMIT, `chunk length ${msg.length} exceeds ${TG_LIMIT}`);
  }
});

test("formatBacktestSummary returns empty array on missing agents", () => {
  assert.deepEqual(formatBacktestSummary({ scheduled_at: "2026-04-19" }), []);
  assert.deepEqual(formatBacktestSummary({ scheduled_at: "2026-04-19", agents: [] }), []);
});
