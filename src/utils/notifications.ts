import * as fs from "node:fs";
import * as path from "node:path";
import { getOpenClawDir, readOpenClawConfig as readStoredOpenClawConfig } from "./openclaw-config.js";

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAgentLabel(agentName: unknown, agentId: unknown): string {
  const name = typeof agentName === "string" && agentName.trim() ? agentName.trim() : "Unknown agent";
  return agentId != null ? `${name} (Agent ${agentId})` : name;
}

function formatPrice(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? `$${num.toFixed(4)}` : String(value ?? "N/A");
}

function formatShortTimestamp(epochSeconds: unknown): string | null {
  const seconds = typeof epochSeconds === "number" ? epochSeconds : Number(epochSeconds);
  if (!Number.isFinite(seconds)) return null;
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(seconds * 1000))} UTC`;
}

function formatRelativeDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "now";
  if (totalSeconds < 60) return "less than a minute";
  if (totalSeconds < 3600) {
    const minutes = Math.round(totalSeconds / 60);
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (totalSeconds < 86400) {
    const hours = Math.round(totalSeconds / 3600);
    return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(totalSeconds / 86400);
  return `about ${days} day${days === 1 ? "" : "s"}`;
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

  const header = `<b>Backtest summary for ${escapeHtml(scheduled_at)}</b>`;
  const blocks = ordered.map((a: any) => {
    const periods = a.periods || [];
    const name = escapeHtml(a.agent_name || "Unknown Agent");
    const lines = [`<b>${name}</b>:`];
    for (const p of periods) {
      const period = `<b>${escapeHtml(p.period)}</b>`;
      if (hasMetrics(p)) {
        lines.push(`  ${period}: Return ${fmt(p.total_return)}, Max drawdown ${fmt(p.max_drawdown)}, Win rate ${fmt(p.win_rate)}`);
      } else {
        lines.push(`  ${period}: No trades in this period`);
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
  const agentLabel = formatAgentLabel(agent_name, agent_id);
  const isSuccess = typeof success === "boolean" ? success : true;
  const sideLabel = String(side ?? "unknown").toUpperCase();
  const symbolLabel = String(symbol ?? "Unknown Symbol").toUpperCase();
  if (!isSuccess) {
    return `[Trade update] ${agentLabel} could not execute a ${sideLabel} order for ${symbolLabel}.`;
  }

  const action = is_entry ? "opened" : "closed";
  const pnlValue = typeof pnl === "number" ? pnl : Number(pnl);
  const pnlSuffix = !is_entry && Number.isFinite(pnlValue)
    ? ` Realized PnL: ${pnlValue >= 0 ? "+" : ""}$${pnlValue.toFixed(4)}.`
    : "";
  return `[Trade update] ${agentLabel} ${action} a ${sideLabel} trade for ${base_amount} ${symbolLabel} at ${formatPrice(execution_price)}.${pnlSuffix}`;
}

export function formatAgentDeactivationNotification(event: any): string {
  if (typeof event?.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  const agentId = event?.agent_id ?? event?.agentId;
  const agentName = event?.agent_name ?? event?.agentName ?? "Unknown Agent";
  const agentLabel = formatAgentLabel(agentName, agentId);
  const rawReason = typeof event?.reason === "string" ? event.reason : "";
  const reason = rawReason === "consecutive_order_failures"
    ? "consecutive order failures"
    : rawReason.replace(/_/g, " ") || "an incident";
  const source = typeof event?.source === "string" && event.source.trim()
    ? ` Reported by ${event.source.trim()}.`
    : "";

  return `[Agent update] ${agentLabel} was deactivated after ${reason}.${source}`;
}

export function formatBillingExpiryNotification(event: any): string {
  if (typeof event?.message === "string" && event.message.trim()) {
    return event.message.trim();
  }

  const agentId = event?.agent_id ?? event?.agentId;
  const agentName = event?.agent_name ?? event?.agentName ?? "Unknown Agent";
  const agentLabel = formatAgentLabel(agentName, agentId);
  const secondsLeft = typeof event?.seconds_left === "number"
    ? event.seconds_left
    : Number(event?.seconds_left);
  const renewalAt = formatShortTimestamp(event?.renewal_at);
  const isExpiredEvent = event?.event === "agent_billing_expired";

  if (Number.isFinite(secondsLeft) && renewalAt) {
    if (isExpiredEvent || secondsLeft <= 0) {
      return `[Billing update] ${agentLabel} billing expired at ${renewalAt}.`;
    }
    return `[Billing reminder] ${agentLabel} billing renews in ${formatRelativeDuration(secondsLeft)}, at ${renewalAt}.`;
  }

  if (renewalAt) {
    return isExpiredEvent
      ? `[Billing update] ${agentLabel} billing expired at ${renewalAt}.`
      : `[Billing reminder] ${agentLabel} billing is due soon, around ${renewalAt}.`;
  }

  return isExpiredEvent
    ? `[Billing update] ${agentLabel} billing has expired.`
    : `[Billing reminder] ${agentLabel} billing is due soon.`;
}

export type TelegramInlineKeyboardButton = {
  text: string;
  url?: string;
  callback_data?: string;
  copy_text?: { text: string };
};
export type TelegramInlineKeyboard = Array<Array<TelegramInlineKeyboardButton>>;

function readTelegramConfig(): { botToken: string | null; chatId: string | null } {
  const openclawDir = getOpenClawDir();
  let botToken: string | null = null;
  let chatId: string | null = null;
  try {
    const config: any = readStoredOpenClawConfig(openclawDir);
    botToken = config.channels?.telegram?.botToken ?? null;
    chatId = config.channels?.telegram?.chatId ?? config.channels?.telegram?.allowFrom?.[0] ?? null;
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

export function createTelegramNotifier(): (message: string, options?: { parseMode?: "HTML" | "MarkdownV2"; buttons?: TelegramInlineKeyboard }) => Promise<void> {
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
    if (options?.buttons) body.reply_markup = { inline_keyboard: options.buttons };
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {}
  };
}
