import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function formatBacktestNotification(event: any): string {
  const { agent_name, period, total_return, max_drawdown, win_rate } = event;
  const name = agent_name || "Unknown Agent";
  const ret = total_return != null ? `${Math.round(total_return * 100) / 100}%` : "N/A";
  const dd = max_drawdown != null ? `${Math.round(max_drawdown * 100) / 100}%` : "N/A";
  const wr = win_rate != null ? `${Math.round(win_rate * 100) / 100}%` : "N/A";
  return `[Backtest Done] ${name} (${period || "?"}): Return ${ret}, MaxDD ${dd}, WinRate ${wr}`;
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
  return `[Trade Executed] Agent ${agentLabel}: ${action} ${sideLabel} ${base_amount} ${symbolLabel} @ $${execution_price}`;
}

function readOpenClawConfig(): { botToken: string | null; chatId: string | null } {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  let botToken: string | null = null;
  let chatId: string | null = null;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));
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

export function createTelegramNotifier(): (message: string) => Promise<void> {
  let telegramBotToken: string | null = null;
  let telegramChatId: string | null = null;

  return async (message: string) => {
    if (!telegramBotToken || !telegramChatId) {
      const config = readOpenClawConfig();
      telegramBotToken = config.botToken;
      telegramChatId = config.chatId;
      if (!telegramBotToken || !telegramChatId) return;
    }
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChatId, text: message }),
      });
    } catch {}
  };
}
