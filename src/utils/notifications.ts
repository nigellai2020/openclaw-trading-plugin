import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readOpenClawConfig as readStoredOpenClawConfig } from "./openclaw-config.js";

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatBacktestSummary(event: any): string[] {
  const { scheduled_at, agents } = event;
  if (!Array.isArray(agents) || agents.length === 0) return [];

  const TG_LIMIT = 4096;
  const fmt = (n: any) => n == null ? "N/A" : `${Math.round(n * 10000) / 100}%`;

  const hasMetrics = (p: any) => p.has_trades !== false && p.total_return != null;
  const scored = agents.map((a: any) => {
    const trading = (a.periods || []).filter(hasMetrics);
    const avg = trading.length
      ? trading.reduce((s: number, p: any) => s + p.total_return, 0) / trading.length
      : null;
    return { ...a, _avg: avg };
  });
  const withTrades = scored
    .filter((a: any) => a._avg != null)
    .sort((a: any, b: any) => b._avg - a._avg);
  const noTrades = scored
    .filter((a: any) => a._avg == null)
    .sort((a: any, b: any) => String(a.agent_name || "").localeCompare(String(b.agent_name || "")));
  const ordered = [...withTrades, ...noTrades];

  const header = `<b>[Auto Backtest Summary] ${escapeHtml(scheduled_at)}</b>`;
  const blocks = ordered.map((a: any) => {
    const periods = a.periods || [];
    const name = escapeHtml(a.agent_name || "Unknown Agent");
    const lines = [`<b>${name}</b>:`];
    for (const p of periods) {
      const period = `<b>${escapeHtml(p.period)}</b>`;
      if (hasMetrics(p)) {
        lines.push(`  ${period}: Ret ${fmt(p.total_return)}, DD ${fmt(p.max_drawdown)}, WR ${fmt(p.win_rate)}`);
      } else {
        lines.push(`  ${period}: no trade`);
      }
    }
    return lines.join("\n");
  });

  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + 2 + block.length > TG_LIMIT) {
      messages.push(current);
      current = block;
    } else {
      current += "\n\n" + block;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export function formatFillNotification(event: any): string {
  if (typeof event?.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  const {
    agent_id,
    agent_name,
    symbol,
    side,
    is_entry,
    base_amount,
    execution_price,
    success,
    pnl,
  } = event;
  const agentDisplayName = agent_name || "Unknown Agent";
  const agentLabel = typeof agent_id === "number"
    ? `${agentDisplayName} (ID: ${agent_id})`
    : agentDisplayName;
  const isSuccess = typeof success === "boolean" ? success : true;
  if (!isSuccess) {
    return `[Trade Failed] Agent ${agentLabel}: ${String(symbol ?? "Unknown Symbol").toUpperCase()} ${String(side ?? "UNKNOWN").toUpperCase()} execution failed`;
  }

  const action = is_entry ? "Opened" : "Closed";
  const sideLabel = String(side ?? "UNKNOWN").toUpperCase();
  const symbolLabel = String(symbol ?? "Unknown Symbol").toUpperCase();
  const pnlValue = typeof pnl === "number" ? pnl : Number(pnl);
  const pnlSuffix = !is_entry && Number.isFinite(pnlValue)
    ? ` | PnL: ${pnlValue >= 0 ? "+" : ""}$${pnlValue.toFixed(4)}`
    : "";
  return `[Trade Executed] Agent ${agentLabel}: ${action} ${sideLabel} ${base_amount} ${symbolLabel} @ $${execution_price}${pnlSuffix}`;
}

export function formatAgentDeactivationNotification(event: any): string {
  if (typeof event?.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  const agentId = event?.agent_id ?? event?.agentId;
  const agentName = event?.agent_name ?? event?.agentName ?? "Unknown Agent";
  const agentLabel = agentId != null
    ? `${agentName} (ID: ${agentId})`
    : agentName;
  const rawReason = typeof event?.reason === "string" ? event.reason : "";
  const reason = rawReason === "consecutive_order_failures"
    ? "consecutive order failures"
    : rawReason.replace(/_/g, " ") || "an incident";
  const source = typeof event?.source === "string" && event.source.trim()
    ? ` Source: ${event.source.trim()}.`
    : "";

  return `[Agent Deactivated] Agent ${agentLabel} has been deactivated due to ${reason}.${source}`;
}

export function formatBillingExpiryNotification(event: any): string {
  if (typeof event?.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  const agentId = event?.agent_id ?? event?.agentId;
  const agentName = event?.agent_name ?? event?.agentName ?? "Unknown Agent";
  const agentLabel = agentId != null
    ? `${agentName} (ID: ${agentId})`
    : agentName;
  const secondsLeft = typeof event?.seconds_left === "number"
    ? event.seconds_left
    : Number(event?.seconds_left);
  const renewalAt = typeof event?.renewal_at === "number"
    ? new Date(event.renewal_at * 1000).toISOString()
    : null;

  if (Number.isFinite(secondsLeft) && renewalAt) {
    return `[Billing Reminder] Agent ${agentLabel} billing expires in ${secondsLeft} seconds (${renewalAt}).`;
  }

  return `[Billing Reminder] Agent ${agentLabel} billing is close to expiry.`;
}

function readTelegramConfig(): { botToken: string | null; chatId: string | null } {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  let botToken: string | null = null;
  let chatId: string | null = null;
  try {
    const config: any = readStoredOpenClawConfig(openclawDir);
    botToken = config.channels?.telegram?.botToken ?? null;
  } catch {}
  try {
    const credentialsDir = path.join(openclawDir, "credentials");
    const credFiles = fs.readdirSync(credentialsDir);
    const allowFromFile = credFiles.find(f => f === "telegram-allowFrom.json") ??
      credFiles.find(f => /^telegram-.+-allowFrom\.json$/.test(f));
    if (allowFromFile) {
      const allowFrom = JSON.parse(fs.readFileSync(path.join(credentialsDir, allowFromFile), "utf8"));
      chatId = allowFrom.allowFrom?.[0] ?? null;
    }
  } catch {}
  return { botToken, chatId };
}

export function createTelegramNotifier(): (message: string, options?: { parseMode?: "HTML" | "MarkdownV2" }) => Promise<void> {
  let telegramBotToken: string | null = null;
  let telegramChatId: string | null = null;

  return async (message, options) => {
    if (!telegramBotToken || !telegramChatId) {
      const config = readTelegramConfig();
      telegramBotToken = config.botToken;
      telegramChatId = config.chatId;
      if (!telegramBotToken || !telegramChatId) return;
    }
    const body: Record<string, unknown> = { chat_id: telegramChatId, text: message };
    if (options?.parseMode) body.parse_mode = options.parseMode;
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {}
  };
}
