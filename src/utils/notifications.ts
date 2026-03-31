import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function formatFillNotification(event: any): string {
  const { agent_name, symbol, side, is_entry, base_amount, execution_price, success } = event;
  const isSuccess = typeof success === "boolean" ? success : true;
  if (!isSuccess) return `[Trade Failed] ${agent_name}: ${symbol} ${side} failed`;
  const action = is_entry ? "Opened" : "Closed";
  return `[Trade] ${agent_name}: ${action} ${side} ${base_amount} ${symbol} @ $${execution_price}`;
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
    const allowFrom = JSON.parse(fs.readFileSync(path.join(openclawDir, "credentials", "telegram-allowFrom.json"), "utf8"));
    chatId = allowFrom.allowFrom?.[0] ?? null;
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
