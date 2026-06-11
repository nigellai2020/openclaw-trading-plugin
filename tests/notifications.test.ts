import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatAgentDeactivationNotification,
  formatBacktestSummary,
  formatBillingExpiryNotification,
  formatFillNotification,
} from "../src/utils/notifications.js";

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
  assert.ok(msg.startsWith("<b>Backtest summary for 2026-04-19</b>"));

  const winIdx = msg.indexOf("<b>WinAgent</b>:");
  const lossIdx = msg.indexOf("<b>LossAgent</b>:");
  const quietIdx = msg.indexOf("<b>QuietAgent</b>:");
  assert.ok(winIdx > 0 && lossIdx > winIdx, "winner should come before loser");
  assert.ok(quietIdx > lossIdx, "no-trade agent should come last");

  assert.ok(msg.includes("<b>180d</b>: No trades in this period"));
  assert.ok(msg.includes("<b>30d</b>: No trades in this period"));
  assert.ok(msg.includes("<b>1d</b>: No trades in this period"));
  assert.ok(!msg.includes("no trades ("));

  assert.ok(msg.includes("Return 12%"));
  assert.ok(msg.includes("Max drawdown 4%"));
  assert.ok(msg.includes("Win rate 70%"));

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

test("formatAgentDeactivationNotification prefers explicit message", () => {
  assert.equal(
    formatAgentDeactivationNotification({
      event: "agent_deactivated",
      message: "Agent 42 has been deactivated after consecutive order failures.",
    }),
    "Agent 42 has been deactivated after consecutive order failures.",
  );
});

test("formatAgentDeactivationNotification formats fallback payload", () => {
  assert.equal(
    formatAgentDeactivationNotification({
      event: "agent_deactivated",
      agent_id: 42,
      agent_name: "Mean Reversion",
      reason: "consecutive_order_failures",
      source: "trading-bot",
    }),
    "[Agent update] Mean Reversion (Agent 42) was deactivated after consecutive order failures. Reported by trading-bot.",
  );
});

test("formatFillNotification formats successful fills with friendlier wording", () => {
  assert.equal(
    formatFillNotification({
      event: "fill_executed",
      agent_id: 42,
      agent_name: "Mean Reversion",
      symbol: "BTC",
      side: "buy",
      is_entry: true,
      base_amount: "0.25",
      execution_price: "65432.1",
      success: true,
    }),
    "[Trade update] Mean Reversion (Agent 42) opened a BUY trade for 0.25 BTC at $65432.1000.",
  );
});

test("formatFillNotification formats failed fills with friendlier wording", () => {
  assert.equal(
    formatFillNotification({
      event: "fill_executed",
      agent_name: "Momentum",
      symbol: "ETH",
      side: "sell",
      success: false,
    }),
    "[Trade update] Momentum could not execute a SELL order for ETH.",
  );
});

test("formatBillingExpiryNotification formats reminders without raw seconds", () => {
  assert.equal(
    formatBillingExpiryNotification({
      event: "billing_expiry_reminder",
      agent_id: 42,
      agent_name: "Mean Reversion",
      seconds_left: 45,
      renewal_at: 1718123456,
    }),
    "[Billing reminder] Mean Reversion (Agent 42) billing renews in less than a minute, at Jun 11, 2024, 4:30 PM UTC.",
  );
});

test("formatBillingExpiryNotification formats expired billing notices", () => {
  assert.equal(
    formatBillingExpiryNotification({
      event: "agent_billing_expired",
      agent_name: "Momentum",
      renewal_at: 1718123456,
    }),
    "[Billing update] Momentum billing expired at Jun 11, 2024, 4:30 PM UTC.",
  );
});
