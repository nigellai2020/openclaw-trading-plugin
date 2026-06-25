import { Type } from "@sinclair/typebox";
import { Crypto, Keys, Nip19 } from "@scom/scom-signer";
import {
  getEvmChainConfig,
  PERP_ALLOWED_CHAIN_IDS,
  SPOT_ALLOWED_CHAIN_IDS,
  validateChainIdForMarketType,
} from "../constants/trading.js";
import {
  createToolsContext,
  type ToolsContext,
} from "../context/create-tools-context.js";
import { SimulationConfig, SimulationConfigPatch, Strategy } from "../schemas/strategy.js";
import { registerNostrNotifications } from "./register-nostr-notifications.js";
import { getAuthHeader, loadKeys, persistKeyToConfig } from "../utils/auth.js";
import { sanitizeBacktestResultResponse } from "../utils/backtest-result.js";
import { normalizeBacktestTimeRange } from "../utils/backtest-time.js";
import { fetchEvmWalletBalances, textResult } from "../utils/live-trading.js";
import {
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramInlineKeyboard,
} from "../utils/notifications.js";
import { fetchSupportedPairsFromApi } from "../utils/supported-pairs.js";

type AgentTradeRange = "12h" | "24h" | "1d" | "3d" | "7d" | "30d" | "all";
type TokenPriceValidationIssue = {
  index: number;
  symbol: string;
  reason: string;
};
type HyperliquidSetupFlowResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    ok: true;
    message: string;
    setupUrl: string;
    token: string;
    network: string;
    expiresAt?: unknown;
    actions: Array<Record<string, unknown>>;
    buttons: Array<Record<string, unknown>>;
    telegram: {
      reply_markup: {
        inline_keyboard: Array<Array<Record<string, unknown>>>;
      };
    };
  };
  _meta: Record<string, unknown>;
};
type HyperliquidSetupFlowSentResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    ok: true;
    telegramMessageSent: true;
    network: string;
    expiresAt?: unknown;
  };
  _meta: Record<string, unknown>;
};
const TELEGRAM_COPY_TEXT_LIMIT = 256;
export const HYPERLIQUID_SETUP_REFRESH_COMMAND = "hlrefresh";

const AGENT_TRADE_RANGE_MS: Record<Exclude<AgentTradeRange, "all">, number> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function applyAgentTradeWindow(
  qs: URLSearchParams,
  input: { range?: AgentTradeRange; startDate?: number; endDate?: number },
) {
  if (input.range) {
    if (input.range !== "all") {
      const endDate = Date.now();
      const startDate = endDate - AGENT_TRADE_RANGE_MS[input.range];
      qs.set("startDate", String(startDate));
      qs.set("endDate", String(endDate));
    }
    return;
  }

  if (input.startDate != null) qs.set("startDate", String(input.startDate));
  if (input.endDate != null) qs.set("endDate", String(input.endDate));
}

const TOKEN_PRICE_SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]*$/;

function validateRequestedTokenSymbols(symbols?: string[]): TokenPriceValidationIssue[] {
  if (!symbols) return [];
  if (symbols.length === 0) {
    return [{
      index: 0,
      symbol: "",
      reason: "symbols must be omitted to request all tracked token prices; do not pass an empty array",
    }];
  }

  return symbols.flatMap((symbol, index) => {
    if (symbol.length === 0) {
      return [{ index, symbol, reason: "symbol is empty" }];
    }
    if (symbol.trim() !== symbol) {
      return [{ index, symbol, reason: "symbol has leading or trailing whitespace" }];
    }
    if (/\s/.test(symbol)) {
      return [{ index, symbol, reason: "symbol must not contain whitespace" }];
    }
    if (symbol.includes("/")) {
      return [{ index, symbol, reason: 'symbol must be a base token like "ETH", not a pair like "ETH/USDC"' }];
    }
    if (symbol.toUpperCase() !== symbol) {
      return [{ index, symbol, reason: "symbol must be uppercase" }];
    }
    if (!TOKEN_PRICE_SYMBOL_RE.test(symbol)) {
      return [{ index, symbol, reason: "symbol must contain only A-Z, 0-9, ., _, or -" }];
    }
    return [];
  });
}

export function buildHyperliquidSetupFlowResult(input: {
  setupUrl: string;
  token: string;
  network: string;
  expiresAt?: unknown;
}): HyperliquidSetupFlowResult {
  const { message, keyboard, refreshCallbackData } = buildHyperliquidSetupTelegramMessage(input);

  const openSetupAction = {
    type: "open_url",
    label: "Open setup app",
    url: input.setupUrl,
  };
  const copyLinkAction = {
    type: "copy_text",
    label: "Copy setup link",
    text: input.setupUrl,
  };
  const refreshLinkAction = {
    type: "callback",
    label: "Refresh link",
    callbackData: refreshCallbackData,
    request: `Request a fresh Hyperliquid ${input.network} setup link`,
  };
  const telegramReplyMarkup = {
    inline_keyboard: keyboard,
  };
  const structuredContent = {
    ok: true as const,
    message,
    setupUrl: input.setupUrl,
    token: input.token,
    network: input.network,
    expiresAt: input.expiresAt,
    actions: [openSetupAction, copyLinkAction, refreshLinkAction],
    buttons: [
      { text: "Open setup app", url: input.setupUrl },
      { text: "Copy setup link", copyText: input.setupUrl },
      { text: "Refresh link", callbackData: refreshCallbackData },
    ],
    telegram: {
      reply_markup: telegramReplyMarkup,
    },
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    _meta: {
      setupUrl: input.setupUrl,
      token: input.token,
      network: input.network,
      expiresAt: input.expiresAt,
      actions: structuredContent.actions,
      buttons: structuredContent.buttons,
      reply_markup: telegramReplyMarkup,
      telegram: structuredContent.telegram,
    },
  };
}

export function buildHyperliquidSetupFlowSentResult(input: {
  network: string;
  expiresAt?: unknown;
  telegramChatId?: string;
  telegramMessageId?: number;
}): HyperliquidSetupFlowSentResult {
  const structuredContent = {
    ok: true as const,
    telegramMessageSent: true as const,
    network: input.network,
    expiresAt: input.expiresAt,
  };
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...structuredContent,
        instruction: "The fixed Telegram setup message with keyboard has already been sent. Do not send any additional user-facing message.",
      }),
    }],
    structuredContent,
    _meta: {
      suppressAssistantMessage: true,
      reason: "Fixed Telegram setup message with keyboard already sent directly by plugin.",
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
    },
  };
}

export function buildHyperliquidSetupTelegramMessage(input: {
  setupUrl: string;
  network: string;
}): {
  message: string;
  keyboard: TelegramInlineKeyboard;
  refreshCallbackData: string;
  refreshInstruction: string;
} {
  const networkLabel = input.network === "mainnet" ? "mainnet" : "testnet";
  const refreshCallbackData = buildHyperliquidSetupRefreshCallbackData(networkLabel);
  const refreshInstruction = "If the link expires, tap Refresh link and I will replace this message with a fresh one.";
  const copyButton = input.setupUrl.length <= TELEGRAM_COPY_TEXT_LIMIT
    ? { text: "Copy link", copy_text: { text: input.setupUrl } }
    : undefined;
  const keyboard: TelegramInlineKeyboard = [
    [{ text: "Open setup app", url: input.setupUrl }],
  ];
  keyboard.push([
    ...(copyButton ? [copyButton] : []),
    { text: "Refresh link", callback_data: refreshCallbackData },
  ]);

  const copyInstruction = copyButton
    ? "Use Copy link if you want to paste it on your desktop computer."
    : "If you want to paste it on your desktop computer, copy the full link below.";

  return {
    message: [
      `Your Hyperliquid ${networkLabel} wallet setup link is ready.`,
      "",
      `It expires in about 15 minutes. Tap Open setup app to connect your Hyperliquid master wallet, generate or import an API wallet, authorize it if needed, and register it with OpenSwap.`,
      "",
      copyInstruction,
      refreshInstruction,
      "",
      `Setup link: ${input.setupUrl}`,
    ].join("\n"),
    keyboard,
    refreshCallbackData,
    refreshInstruction,
  };
}

export function buildHyperliquidSetupRefreshCommand(network: string): string {
  const networkLabel = network === "mainnet" ? "mainnet" : "testnet";
  return `/${HYPERLIQUID_SETUP_REFRESH_COMMAND} ${networkLabel}`;
}

export function buildHyperliquidSetupRefreshCallbackData(network: string): string {
  const networkLabel = network === "mainnet" ? "mainnet" : "testnet";
  return `${HYPERLIQUID_SETUP_REFRESH_COMMAND}:${networkLabel}`;
}

type HyperliquidSetupRequestResult = {
  token: string;
  network: string;
  setupUrl: string;
  expiresAt?: unknown;
};

async function requestHyperliquidSetupFlow(input: {
  network: string;
  pluginConfig: any;
  baseUrl: string;
  parseResponseBody: (res: Response) => Promise<unknown>;
  responseErrorMessage: (body: unknown) => string;
  debugLog: (tool: string, step: string, data: unknown) => void;
}): Promise<HyperliquidSetupRequestResult> {
  const { privateKey, publicKey } = loadKeys(input.pluginConfig);
  const network = input.network === "mainnet" ? "mainnet" : "testnet";
  const configuredManagementUrl = input.pluginConfig.hyperliquidManagementUrl;
  if (typeof configuredManagementUrl !== "string" || configuredManagementUrl.trim() === "") {
    throw new Error("hyperliquidManagementUrl is not configured");
  }
  const hyperliquidManagementUrl = configuredManagementUrl.trim().replace(/\/+$/, "");
  const auth = getAuthHeader(publicKey, privateKey);
  const requestBody = { network };

  input.debugLog("hyperliquid_setup_flow", "api.req POST /api/hyperliquid/setup-flow/request", requestBody);
  const res = await fetch(`${input.baseUrl}/api/hyperliquid/setup-flow/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(requestBody),
  });
  const resBody = await input.parseResponseBody(res);
  input.debugLog("hyperliquid_setup_flow", "api.res POST /api/hyperliquid/setup-flow/request", { status: res.status, body: resBody });

  if (!res.ok) {
    const backendError = input.responseErrorMessage(resBody);
    throw new Error(`Failed to request setup flow: ${res.status}${backendError ? ` ${backendError}` : ""}`);
  }

  const token = (resBody as any)?.data?.token;
  if (!token) {
    throw new Error("No setup token received from backend");
  }

  return {
    token,
    network,
    setupUrl: `${hyperliquidManagementUrl}/?token=${encodeURIComponent(token)}&network=${network}`,
    expiresAt: (resBody as any)?.data?.expiresAt,
  };
}

type HyperliquidRefreshCommandInput = {
  network?: string;
  telegramChatId?: string;
  telegramMessageId?: number;
};

function valueAtPath(source: unknown, path: Array<string>): unknown {
  let current = source;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asStringId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asMessageId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function collectCommandText(value: unknown, out: string[], depth = 0) {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCommandText(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  for (const key of [
    "args",
    "command",
    "commandBody",
    "text",
    "data",
    "callbackData",
    "callback_data",
    "message",
    "prompt",
    "content",
    "update",
    "event",
    "raw",
    "telegram",
    "callback_query",
    "callbackQuery",
  ]) {
    collectCommandText(obj[key], out, depth + 1);
  }
}

function extractTelegramMessageMetadata(args: unknown[]): { chatId?: string; messageId?: number } {
  const messagePaths = [
    ["callback_query", "message"],
    ["callbackQuery", "message"],
    ["update", "callback_query", "message"],
    ["update", "callbackQuery", "message"],
    ["event", "callback_query", "message"],
    ["event", "callbackQuery", "message"],
    ["raw", "callback_query", "message"],
    ["raw", "callbackQuery", "message"],
    ["telegram", "callback_query", "message"],
    ["telegram", "callbackQuery", "message"],
  ];
  for (const arg of args) {
    for (const path of messagePaths) {
      const message = valueAtPath(arg, path);
      if (!message || typeof message !== "object") continue;
      const chatId = asStringId(valueAtPath(message, ["chat", "id"]) ?? valueAtPath(message, ["chat_id"]) ?? valueAtPath(message, ["chatId"]));
      const messageId = asMessageId(valueAtPath(message, ["message_id"]) ?? valueAtPath(message, ["messageId"]));
      if (chatId && messageId !== undefined) return { chatId, messageId };
    }
  }

  for (const arg of args) {
    const chatId = asStringId(
      valueAtPath(arg, ["telegramChatId"]) ??
      valueAtPath(arg, ["chatId"]) ??
      valueAtPath(arg, ["chat_id"]),
    );
    const messageId = asMessageId(
      valueAtPath(arg, ["telegramMessageId"]) ??
      valueAtPath(arg, ["messageId"]) ??
      valueAtPath(arg, ["message_id"]),
    );
    if (chatId && messageId !== undefined) return { chatId, messageId };
  }

  return {};
}

export function extractHyperliquidSetupRefreshCommandInput(args: unknown[]): HyperliquidRefreshCommandInput {
  const texts: string[] = [];
  collectCommandText(args, texts);
  const joined = texts.join(" ").toLowerCase();
  const metadata = extractTelegramMessageMetadata(args);
  return {
    network: joined.includes("mainnet") ? "mainnet" : joined.includes("testnet") ? "testnet" : undefined,
    telegramChatId: metadata.chatId,
    telegramMessageId: metadata.messageId,
  };
}

function normalizeHyperliquidSetupRefreshNetwork(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("mainnet")) return "mainnet";
  if (text.includes("testnet")) return "testnet";
  return undefined;
}

async function refreshHyperliquidSetupFlow(input: {
  network: string;
  telegramChatId?: string;
  telegramMessageId?: number;
  pluginConfig: any;
  baseUrl: string;
  parseResponseBody: (res: Response) => Promise<unknown>;
  responseErrorMessage: (body: unknown) => string;
  debugLog: (tool: string, step: string, data: unknown) => void;
}) {
  const setup = await requestHyperliquidSetupFlow(input);
  const setupMessage = buildHyperliquidSetupTelegramMessage({ setupUrl: setup.setupUrl, network: setup.network });

  if (input.telegramChatId && input.telegramMessageId !== undefined) {
    const edited = await editTelegramMessage({
      chatId: input.telegramChatId,
      messageId: input.telegramMessageId,
      text: setupMessage.message,
      buttons: setupMessage.keyboard,
    });
    if (edited) {
      return { ...setup, telegramMessageUpdated: true, telegramMessageSent: false };
    }

    const sent = await sendTelegramMessage(setupMessage.message, { buttons: setupMessage.keyboard });
    if (sent.ok) {
      const oldMessageDeleted = await deleteTelegramMessage({
        chatId: input.telegramChatId,
        messageId: input.telegramMessageId,
      });
      return {
        ...setup,
        telegramMessageUpdated: false,
        telegramMessageSent: true,
        oldMessageDeleted,
        telegramChatId: sent.chatId,
        telegramMessageId: sent.messageId,
      };
    }
  }

  const sent = await sendTelegramMessage(setupMessage.message, { buttons: setupMessage.keyboard });
  return {
    ...setup,
    telegramMessageUpdated: false,
    telegramMessageSent: sent.ok,
    telegramChatId: sent.chatId,
    telegramMessageId: sent.messageId,
  };
}

export function registerHyperliquidSetupRefreshCommand(api: any, input: {
  pluginConfig: any;
  baseUrl: string;
  defaultHyperliquidNetwork: string;
  parseResponseBody: (res: Response) => Promise<unknown>;
  responseErrorMessage: (body: unknown) => string;
  debugLog: (tool: string, step: string, data: unknown) => void;
}) {
  if (typeof api?.registerCommand !== "function") return false;

  const handler = async (...args: unknown[]) => {
    const commandInput = extractHyperliquidSetupRefreshCommandInput(args);
    const commandContext = args.find((arg) => arg && typeof arg === "object") as Record<string, unknown> | undefined;
    const network =
      commandInput.network ??
      normalizeHyperliquidSetupRefreshNetwork(commandContext?.args) ??
      normalizeHyperliquidSetupRefreshNetwork(commandContext?.commandBody) ??
      input.defaultHyperliquidNetwork;
    input.debugLog("hyperliquid_setup_refresh_command", "entry", {
      network,
      hasTelegramMessage: Boolean(commandInput.telegramChatId && commandInput.telegramMessageId !== undefined),
    });

    try {
      const result = await refreshHyperliquidSetupFlow({
        network,
        telegramChatId: commandInput.telegramChatId,
        telegramMessageId: commandInput.telegramMessageId,
        pluginConfig: input.pluginConfig,
        baseUrl: input.baseUrl,
        parseResponseBody: input.parseResponseBody,
        responseErrorMessage: input.responseErrorMessage,
        debugLog: input.debugLog,
      });
      input.debugLog("hyperliquid_setup_refresh_command", "result", result);
      return {};
    } catch (e: any) {
      const result = { ok: false, error: e.message, network };
      input.debugLog("hyperliquid_setup_refresh_command", "result", result);
      return { text: "I could not refresh the Hyperliquid setup link. Please try again." };
    }
  };

  const description = "Refresh a Hyperliquid setup link from an inline Telegram button without invoking the LLM.";
  try {
    api.registerCommand({
      name: HYPERLIQUID_SETUP_REFRESH_COMMAND,
      description,
      acceptsArgs: true,
      channels: ["telegram"],
      handler,
    });
    return true;
  } catch (firstError) {
    try {
      api.registerCommand({
        name: HYPERLIQUID_SETUP_REFRESH_COMMAND,
        description,
        acceptsArgs: true,
        handler,
      });
      return true;
    } catch (secondError) {
      try {
        api.registerCommand({
          name: HYPERLIQUID_SETUP_REFRESH_COMMAND,
          description,
          acceptsArgs: true,
          handler,
        });
        return true;
      } catch (thirdError) {
        input.debugLog("hyperliquid_setup_refresh_command", "registration_failed", {
          firstError: String(firstError),
          secondError: String(secondError),
          thirdError: String(thirdError),
        });
        return false;
      }
    }
  }
}

export function registerHyperliquidSetupRefreshInteractiveHandler(api: any, input: {
  pluginConfig: any;
  baseUrl: string;
  defaultHyperliquidNetwork: string;
  parseResponseBody: (res: Response) => Promise<unknown>;
  responseErrorMessage: (body: unknown) => string;
  debugLog: (tool: string, step: string, data: unknown) => void;
}) {
  if (typeof api?.registerInteractiveHandler !== "function") return false;

  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: HYPERLIQUID_SETUP_REFRESH_COMMAND,
    handler: async (ctx: any) => {
      const network =
        normalizeHyperliquidSetupRefreshNetwork(ctx?.callback?.payload) ??
        input.defaultHyperliquidNetwork;
      input.debugLog("hyperliquid_setup_refresh_interactive", "entry", {
        network,
        chatId: ctx?.callback?.chatId,
        messageId: ctx?.callback?.messageId,
      });

      try {
        const result = await refreshHyperliquidSetupFlow({
          network,
          telegramChatId: typeof ctx?.callback?.chatId === "string" ? ctx.callback.chatId : undefined,
          telegramMessageId: typeof ctx?.callback?.messageId === "number" ? ctx.callback.messageId : undefined,
          pluginConfig: input.pluginConfig,
          baseUrl: input.baseUrl,
          parseResponseBody: input.parseResponseBody,
          responseErrorMessage: input.responseErrorMessage,
          debugLog: input.debugLog,
        });
        input.debugLog("hyperliquid_setup_refresh_interactive", "result", result);
      } catch (e: any) {
        const result = { ok: false, error: e.message, network };
        input.debugLog("hyperliquid_setup_refresh_interactive", "result", result);
        await ctx?.respond?.reply?.({
          text: "I could not refresh the Hyperliquid setup link. Please try again.",
        });
      }

      return { handled: true };
    },
  });
  return true;
}

function resolveChainLabel(chainId: number | null | undefined): string | null {
  if (chainId == null) return null;
  if (chainId === 998) return "Hyperliquid Testnet";
  if (chainId === 999) return "Hyperliquid Mainnet";
  const evmConfig = getEvmChainConfig(chainId);
  if (evmConfig?.networkLabel) return evmConfig.networkLabel;
  return `Chain ${chainId}`;
}

export default function registerTools(api: any, ctx: ToolsContext = createToolsContext(api)) {
  const {
    pluginConfig,
    baseUrl,
    walletAgentUrl,
    settlementEngineUrl,
    enableAmmSpot,
    defaultHyperliquidNetwork,
    defaultHyperliquidChainId,
    webUrl,
    debugLog,
    responseErrorMessage,
    resolveMarketType,
    ensureAmmSpotEnabled,
    resolveLiveChainId,
    hasOwnField,
    normalizeAddress,
    inferSymbolFromStrategy,
    inferLiveProtocol,
    buildDerivedSimulationConfig,
    resolveWalletRecord,
    parseResponseBody,
    fetchAgentSettingsForUpdate,
    fetchWalletsForUpdate,
    fetchPublicAgentProfile,
  } = ctx;

  registerHyperliquidSetupRefreshCommand(api, {
    pluginConfig,
    baseUrl,
    defaultHyperliquidNetwork,
    parseResponseBody,
    responseErrorMessage,
    debugLog,
  });
  registerHyperliquidSetupRefreshInteractiveHandler(api, {
    pluginConfig,
    baseUrl,
    defaultHyperliquidNetwork,
    parseResponseBody,
    responseErrorMessage,
    debugLog,
  });

  // ── Existing tools ──────────────────────────────────────────────

  api.registerTool({
    name: "get_token_prices",
    description:
      "Get current live token prices from the API. " +
      "Use this for current/latest/live price questions. " +
      "OpenClaw must normalize user input before calling this tool. " +
      'When `symbols` is provided, pass uppercase base-token symbols only, like "ETH" or "BTC". ' +
      'Pair forms like "ETH/USDC", lowercase entries, or whitespace-padded values are rejected so OpenClaw can retry.',
    parameters: Type.Object({
      symbols: Type.Optional(
        Type.Array(
          Type.String({
            description:
              'Optional uppercase base-token symbols only, for example ["ETH", "BTC"]. ' +
              'OpenClaw must normalize user input before calling. Omit `symbols` to fetch all tracked token prices.',
          }),
        ),
      ),
    }),
    async execute(_id: string, params: { symbols?: string[] }) {
      const invalidSymbols = validateRequestedTokenSymbols(params.symbols);
      if (invalidSymbols.length > 0) {
        return textResult({
          success: false,
          error: "Invalid symbol format. OpenClaw must retry with normalized uppercase base-token symbols.",
          invalidSymbols,
          retryable: true,
          retryInstruction:
            'Retry `get_token_prices` with symbols like ["ETH"] or ["BTC","SOL"]. Do not pass pairs, lowercase symbols, or whitespace-padded values.',
        });
      }

      const res = await fetch(`${baseUrl}/api/token-prices`);
      const body = await parseResponseBody(res);
      if (!res.ok) throw new Error(`token-prices failed: ${res.status} ${responseErrorMessage(body)}`);

      const rows = Array.isArray(body?.data) ? body.data : [];
      const baseResult: Record<string, unknown> =
        typeof body === "object" && body !== null
          ? { ...(body as Record<string, unknown>) }
          : { data: rows };

      if (!params.symbols) {
        return textResult({
          ...baseResult,
          data: rows,
          source: "/api/token-prices",
        });
      }

      const rowBySymbol = new Map<string, any>();
      for (const row of rows) {
        if (typeof row?.symbol === "string" && !rowBySymbol.has(row.symbol)) {
          rowBySymbol.set(row.symbol, row);
        }
      }

      const data = params.symbols.flatMap((symbol) => {
        const row = rowBySymbol.get(symbol);
        return row ? [row] : [];
      });
      const unavailableSymbols = params.symbols.filter((symbol) => !rowBySymbol.has(symbol));

      return textResult({
        ...baseResult,
        success: typeof baseResult.success === "boolean" ? baseResult.success : true,
        requestedSymbols: params.symbols,
        data,
        unavailableSymbols,
        source: "/api/token-prices",
      });
    },
  });

  api.registerTool({
    name: "get_ohlc",
    description: "Get OHLC candle data for a specific symbol",
    parameters: Type.Object({
      symbol: Type.String({ description: 'Trading pair, e.g. "BTC/USDC"' }),
      from: Type.Optional(
        Type.Number({ description: "Start timestamp (Unix seconds)" }),
      ),
      to: Type.Optional(
        Type.Number({ description: "End timestamp (Unix seconds)" }),
      ),
      resolution: Type.Optional(
        Type.String({
          description:
            'Candle resolution. One of "1", "5", "15", "30", "60", "240", "1D"',
          default: "60",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: {
        symbol: string;
        from?: number;
        to?: number;
        resolution?: string;
      },
    ) {
      const qs = new URLSearchParams({ symbol: params.symbol });
      if (params.from != null) qs.set("from", String(params.from));
      if (params.to != null) qs.set("to", String(params.to));
      if (params.resolution) qs.set("resolution", params.resolution);

      const res = await fetch(`${baseUrl}/api/ohlc?${qs}`);
      if (!res.ok) throw new Error(`ohlc failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_supported_pairs",
    description:
      "Get supported trading pairs and which venues (protocol + chain) they are available on. " +
      "Returns crypto pairs with venue availability. " +
      "Use the optional protocol filter to narrow results.",
    parameters: Type.Object({
      protocol: Type.Optional(
        Type.String({
          description:
            '"uniswap" or "hyperliquid". Filters to pairs available on this protocol. Omit for all.',
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { protocol?: string },
    ) {
      let results = await fetchSupportedPairsFromApi(baseUrl);

      if (!enableAmmSpot) {
        results = results
          .map((p) => ({
            ...p,
            venues: p.venues.filter((v) => v.protocol !== "amm"),
          }))
          .filter((p) => p.venues.length > 0);
      }

      if (params.protocol) {
        results = results
          .map((p) => ({
            ...p,
            venues: p.venues.filter((v) => v.protocol === params.protocol),
          }))
          .filter((p) => p.venues.length > 0);
      }

      return textResult({ pairs: results, total: results.length });
    },
  });


  api.registerTool({
    name: "get_agent_trades",
    description: "Get past trades and trade history for a single agent. Each trade includes both entry and exit information in a single object, making it easy to understand the complete trade lifecycle. Returns trades with PnL calculations, fees, timestamps, and status (open/closed).",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID" }),
      type: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("entry"),
        Type.Literal("exit"),
      ], { description: 'Trade status filter: "all" (default), "entry" (open trades only), or "exit" (closed trades only)' })),
      range: Type.Optional(Type.Union([
        Type.Literal("12h"),
        Type.Literal("24h"),
        Type.Literal("1d"),
        Type.Literal("3d"),
        Type.Literal("7d"),
        Type.Literal("30d"),
        Type.Literal("all"),
      ], {
        description:
          'Relative time window. Use "12h", "24h", "1d", "3d", "7d", "30d", or "all". If provided, this overrides explicit startDate/endDate.',
      })),
      startDate: Type.Optional(Type.Number({
        description: "Start timestamp in Unix milliseconds or seconds. Ignored when range is provided.",
      })),
      endDate: Type.Optional(Type.Number({
        description: "End timestamp in Unix milliseconds or seconds. Ignored when range is provided.",
      })),
      page: Type.Optional(Type.Number({ description: "Page number" })),
      pageSize: Type.Optional(Type.Number({ description: "Results per page (default: 100, max: 100)" })),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
        type?: "all" | "entry" | "exit";
        range?: AgentTradeRange;
        startDate?: number;
        endDate?: number;
        page?: number;
        pageSize?: number;
      },
    ) {
      const qs = new URLSearchParams();
      if (params.type) qs.set("type", params.type);
      applyAgentTradeWindow(qs, {
        range: params.range,
        startDate: params.startDate,
        endDate: params.endDate,
      });
      if (params.page != null) qs.set("page", String(params.page));
      if (params.pageSize != null) qs.set("pageSize", String(params.pageSize));

      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const url = `${baseUrl}/api/trades/${params.agentId}${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`get_agent_trades failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_open_positions",
    description: "Get the current open positions for a single agent. This calls GET /api/positions/:traderId and returns open positions only.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID" }),
      page: Type.Optional(Type.Number({ description: "Page number" })),
      pageSize: Type.Optional(Type.Number({ description: "Results per page" })),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
        page?: number;
        pageSize?: number;
      },
    ) {
      const qs = new URLSearchParams();
      if (params.page != null) qs.set("page", String(params.page));
      if (params.pageSize != null) qs.set("pageSize", String(params.pageSize));

      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const url = `${baseUrl}/api/positions/${params.agentId}${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`get_open_positions failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "close_all_trades",
    description: "Queue close-all for all open positions of one agent via POST /api/agent/:id/close-all-trades.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID" }),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
      },
    ) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);

      const res = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(String(params.agentId))}/close-all-trades`, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
      });

      const body = await parseResponseBody(res);
      if (!res.ok) {
        return textResult({
          success: false,
          status: res.status,
          error: responseErrorMessage(body),
          agentId: params.agentId,
        });
      }

      return textResult(body);
    },
  });

  // ── Identity tools ─────────────────────────────────────

  api.registerTool({
    name: "get_nostr_identity",
    description: "Get the user's Nostr npub and public key (read-only, no side effects)",
    parameters: Type.Object({}),
    async execute() {
      const pk = pluginConfig.nostrPrivateKey;
      if (!pk) {
        return textResult({ exists: false });
      }
      const publicKey = Keys.getPublicKey(pk);
      return textResult({ npub: Nip19.npubEncode(publicKey), publicKey });
    },
  });

  // ── Live-trade tools ──────────────────────────────────────────

  api.registerTool({
    name: "get_hyperliquid_balance",
    description: "Get Hyperliquid balance for the authenticated user by passing either a master wallet address or an agent wallet address. Defaults to USDC and resolves agent wallet to its master wallet automatically.",
    parameters: Type.Object({
      walletAddress: Type.Optional(Type.String({ description: "Wallet address (0x...) that can be either master or agent" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Master wallet address (backward-compatible alias). Prefer walletAddress." })),
      agentWalletAddress: Type.Optional(Type.String({ description: "Agent wallet address (backward-compatible alias). Prefer walletAddress." })),
      chainId: Type.Optional(Type.Number({ description: "998=testnet, 999=mainnet. Defaults to the configured network." })),
      coin: Type.Optional(Type.String({ description: "Coin symbol to query. Defaults to USDC." })),
    }),
    async execute(
      _id: string,
      params: { walletAddress?: string; masterWalletAddress?: string; agentWalletAddress?: string; chainId?: number; coin?: string },
    ) {
      const requestedWalletAddress = params.walletAddress ?? params.masterWalletAddress ?? params.agentWalletAddress;
      if (!requestedWalletAddress) {
        return textResult({
          success: false,
          error: "Provide one of walletAddress, masterWalletAddress, or agentWalletAddress.",
        });
      }

      const chainId = params.chainId ?? defaultHyperliquidChainId;
      const coin = params.coin?.trim();
      const qs = new URLSearchParams({
        walletAddress: requestedWalletAddress,
        chainId: String(chainId),
      });
      if (coin) {
        qs.set("coin", coin);
      }

      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/hyperliquid/balance?${qs.toString()}`, {
        headers: { Authorization: auth },
      });
      const body = await parseResponseBody(res);

      if (!res.ok) {
        return textResult({
          success: false,
          error: responseErrorMessage(body),
          status: res.status,
          walletAddress: requestedWalletAddress,
          chainId,
          coin: coin?.toUpperCase() || "USDC",
        });
      }

      return textResult(body);
    },
  });

  api.registerTool({
    name: "get_evm_wallet_balance",
    description: "Get the native token and USDC balances of an EVM wallet address for a specific EVM network (e.g. Ethereum chainId=1, BSC chainId=56). Use the master wallet address, not the agent/API wallet.",
    parameters: Type.Object({
      masterWalletAddress: Type.String({ description: "Master wallet address (0x...)" }),
      chainId: Type.Number({ description: "EVM chain ID (e.g. 1=Ethereum, 56=BSC)" }),
    }),
    async execute(
      _id: string,
      params: { masterWalletAddress: string; chainId: number },
    ) {
      const chainConfig = getEvmChainConfig(params.chainId);
      if (!chainConfig) {
        return textResult({ error: `Unsupported EVM chain ID: ${params.chainId}. Supported chains: Ethereum (1), BNB Chain (56).` });
      }
      debugLog("get_evm_wallet_balance", "entry", { masterWalletAddress: params.masterWalletAddress, chainId: params.chainId, rpcUrl: chainConfig.rpcUrl });
      try {
        const balances = await fetchEvmWalletBalances(
          params.masterWalletAddress,
          chainConfig.rpcUrl,
          chainConfig.usdcAddress,
          chainConfig.usdcDecimals,
        );
        return textResult({
          masterWalletAddress: params.masterWalletAddress,
          chainId: params.chainId,
          networkLabel: chainConfig.networkLabel,
          nativeBalance: balances.nativeBalance,
          nativeSymbol: chainConfig.nativeSymbol,
          usdcBalance: balances.usdcBalance,
          usdcAddress: chainConfig.usdcAddress,
        });
      } catch (e: any) {
        return textResult({ error: e.message });
      }
    },
  });

  api.registerTool({
    name: "get_agent",
    description: "Get details of a trading agent by ID",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to retrieve" }),
    }),
    async execute(_id: string, params: { agentId: number }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`get_agent failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "update_agent",
    description: "Update a trading agent via PUT /api/agent. The server handles all downstream trading-bot and settlement syncing internally. Conservative mode: only explicitly provided fields are updated; when companion fields are missing for a safe live update, ask the user for them before retrying.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to update" }),
      name: Type.Optional(Type.String({ description: "Updated agent name" })),
      description: Type.Optional(Type.String({ description: "Updated agent description" })),
      avatarUrl: Type.Optional(Type.String({ description: "Updated avatar URL" })),
      strategy: Type.Optional(Strategy),
      strategyDescription: Type.Optional(Type.String({ description: "Updated human-readable strategy description" })),
      isActive: Type.Optional(Type.Boolean({ description: "Enable or disable the agent" })),
      leverage: Type.Optional(Type.Number({ description: "Updated leverage multiplier" })),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"' })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"' })),
      symbol: Type.Optional(Type.String({ description: 'Updated trader symbol, e.g. "ETH/USDC"' })),
      chainId: Type.Optional(Type.Number({ description: "Updated settlement/simulation chain ID" })),
      protocol: Type.Optional(Type.String({ description: 'Updated protocol, e.g. "hyperliquid" or "uniswap_v3"' })),
      initialCapital: Type.Optional(Type.Number({ description: "Updated paper starting capital. Only allowed when switching to paper mode." })),
      walletAddress: Type.Optional(Type.String({ description: "Live wallet selector mapped to wallet_address. Can be a master wallet or agent wallet address in oswap_wallets." })),
      settlementConfig: Type.Optional(Type.Object({
        ethAddress: Type.String({ description: "Master wallet address used by settlement (maps to settlement_config.eth_address)" }),
        agentAddress: Type.Optional(Type.String({ description: "Agent/API wallet address (maps to settlement_config.agent_address). If omitted, backend falls back to ethAddress." })),
      })),
      simulationConfig: Type.Optional(SimulationConfigPatch),
      positionQty: Type.Optional(Type.Number({ description: "Updated settlement position quantity" })),
      slippage: Type.Optional(Type.Number({ description: "Updated settlement slippage tolerance" })),
      expiration: Type.Optional(Type.Number({ description: "Updated settlement transaction expiration in seconds" })),
      isPrivate: Type.Optional(Type.Boolean({ description: 'Change agent visibility. false makes a private agent public (irreversible). Setting true on an already-public agent is rejected with 400. Copy agents can never be made public.' })),
      copiedFromAgentId: Type.Optional(Type.Number({ description: "Change the source agent this copied agent follows. The source agent must be public. Triggers automatic strategy sync on the backend." })),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
        name?: string;
        description?: string;
        avatarUrl?: string;
        strategy?: Record<string, unknown>;
        strategyDescription?: string;
        isActive?: boolean;
        leverage?: number;
        mode?: string;
        marketType?: string;
        symbol?: string;
        chainId?: number;
        protocol?: string;
        initialCapital?: number;
        walletAddress?: string;
        settlementConfig?: {
          ethAddress: string;
          agentAddress?: string;
        };
        simulationConfig?: {
          protocol?: string;
          chain_id?: number;
        };
        positionQty?: number;
        slippage?: number;
        expiration?: number;
        isPrivate?: boolean;
        copiedFromAgentId?: number;
      },
    ) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const signedAt = Math.floor(Date.now() / 1000);
      const requestedFields = [
        "name",
        "description",
        "avatarUrl",
        "strategy",
        "strategyDescription",
        "isActive",
        "leverage",
        "mode",
        "marketType",
        "symbol",
        "chainId",
        "protocol",
        "initialCapital",
        "walletAddress",
        "settlementConfig",
        "simulationConfig",
        "positionQty",
        "slippage",
        "expiration",
        "isPrivate",
        "copiedFromAgentId",
      ].filter((field) => hasOwnField(params, field));

      if (requestedFields.length === 0) {
        return textResult({ error: "At least one updatable field is required" });
      }
      if (params.mode != null && params.mode !== "paper" && params.mode !== "live") {
        return textResult({ error: 'mode must be "paper" or "live"' });
      }
      if (params.marketType != null && params.marketType !== "spot" && params.marketType !== "perp") {
        return textResult({ error: 'marketType must be "spot" or "perp"' });
      }
      if (hasOwnField(params, "copiedFromAgentId") && hasOwnField(params, "isPrivate")) {
        return textResult({
          error: "Do not send isPrivate together with copiedFromAgentId. Copied agents are always private; ask the user only for the source agent ID.",
        });
      }
      if (hasOwnField(params, "walletAddress") && hasOwnField(params, "settlementConfig")) {
        return textResult({
          error: "Provide either walletAddress or settlementConfig for live wallet selection, not both.",
        });
      }

      debugLog("update_agent", "entry", { requestedFields, ...params });

      const result: Record<string, any> = {
        preflight: {
          agentId: params.agentId,
          requestedFields,
        },
        warnings: [] as string[],
      };
      const warnings = result.warnings as string[];

      let currentSettings: any;
      let publicAgentBody: any = null;
      let wallets: any[] = [];

      try {
        const [settings, publicAgentRes] = await Promise.all([
          fetchAgentSettingsForUpdate(auth, params.agentId),
          fetch(`${baseUrl}/api/agent/${params.agentId}`, {
            headers: { Authorization: auth },
          })
            .then(async (res) => await parseResponseBody(res))
            .catch(() => null),
        ]);
        currentSettings = settings;
        publicAgentBody = publicAgentRes;
      } catch (e: any) {
        result.error = e.message;
        debugLog("update_agent", "preflight.error", result);
        return textResult(result);
      }

      try {
        wallets = await fetchWalletsForUpdate(auth);
      } catch (e: any) {
        warnings.push(`Could not load wallets for update preflight: ${e.message}`);
      }

      const currentMode: "paper" | "live" = currentSettings?.mode === "live" ? "live" : "paper";
      const targetMode: "paper" | "live" = params.mode === "live"
        ? "live"
        : params.mode === "paper"
          ? "paper"
          : currentMode;
      const currentMarketType: "spot" | "perp" = currentSettings?.marketType === "perp" ? "perp" : "spot";
      const targetMarketType: "spot" | "perp" = params.marketType === "perp"
        ? "perp"
        : params.marketType === "spot"
          ? "spot"
          : currentMarketType;
      const modeTransitionRequested = hasOwnField(params, "mode") && targetMode !== currentMode;
      try {
        ensureAmmSpotEnabled(targetMode, targetMarketType);
      } catch (e: any) {
        return textResult({ ...result, error: e.message });
      }

      if (hasOwnField(params, "initialCapital")) {
        if (!modeTransitionRequested) {
          return textResult({
            ...result,
            error: "initialCapital can only be updated when switching mode",
          });
        }
        if (targetMode !== "paper") {
          return textResult({
            ...result,
            error: "initialCapital can only be provided when switching to paper mode",
          });
        }
        if (typeof params.initialCapital !== "number" || !Number.isFinite(params.initialCapital) || params.initialCapital <= 0) {
          return textResult({
            ...result,
            error: "initialCapital must be a positive number",
          });
        }
      }

      if (targetMode === "paper") {
        const invalidPaperFields = ["settlementConfig", "walletAddress"].filter((field) => hasOwnField(params, field));
        if (invalidPaperFields.length > 0) {
          return textResult({
            ...result,
            error: `The following fields are live-only and must not be sent when mode is paper: ${invalidPaperFields.join(", ")}`,
          });
        }
      }

      if (params.chainId != null) {
        const chainErr = validateChainIdForMarketType(params.chainId, targetMarketType);
        if (chainErr) return textResult({ ...result, error: chainErr });
      }

      const currentWalletRecord = resolveWalletRecord(wallets, {
        walletAddress: currentSettings?.walletAddress,
      });
      const requestedWalletAddress = params.walletAddress;
      const requestedSettlementAgentAddress = params.settlementConfig?.agentAddress;
      const requestedSettlementMasterWalletAddress = params.settlementConfig?.ethAddress;
      const requestedWalletRecord = resolveWalletRecord(wallets, {
        walletAddress: requestedWalletAddress ?? requestedSettlementAgentAddress,
      });
      if (
        hasOwnField(params, "walletAddress") &&
        requestedWalletAddress != null &&
        !requestedWalletRecord
      ) {
        return textResult({
          ...result,
          error: `walletAddress ${requestedWalletAddress} was not found in the current wallet list`,
        });
      }
      if (
        hasOwnField(params, "settlementConfig") &&
        requestedSettlementAgentAddress != null &&
        !requestedWalletRecord
      ) {
        return textResult({
          ...result,
          error: `settlementConfig.agentAddress ${requestedSettlementAgentAddress} was not found in the current wallet list`,
        });
      }
      if (hasOwnField(params, "settlementConfig") && !requestedSettlementMasterWalletAddress) {
        return textResult({
          ...result,
          error: "settlementConfig.ethAddress is required when settlementConfig is provided",
        });
      }

      const resolvedWalletRecord = requestedWalletRecord ?? currentWalletRecord;
      const nextStrategy = hasOwnField(params, "strategy") ? params.strategy : currentSettings?.strategy;
      const currentSymbol = inferSymbolFromStrategy(currentSettings?.strategy);
      const resolvedSymbol = params.symbol ?? inferSymbolFromStrategy(nextStrategy) ?? currentSymbol ?? null;
      const resolvedChainId = hasOwnField(params, "chainId") ? params.chainId ?? null : currentSettings?.chainId ?? null;
      const resolvedWalletAddress =
        requestedWalletAddress ??
        requestedSettlementAgentAddress ??
        requestedWalletRecord?.wallet_address ??
        currentSettings?.walletAddress ??
        currentWalletRecord?.wallet_address ??
        null;
      const resolvedMasterWalletAddress =
        requestedSettlementMasterWalletAddress ??
        requestedWalletRecord?.master_wallet_address ??
        currentWalletRecord?.master_wallet_address ??
        null;
      const resolvedWalletNetwork =
        requestedWalletRecord?.hyperliquid_network ??
        currentWalletRecord?.hyperliquid_network ??
        null;
      const resolvedLeverage = hasOwnField(params, "leverage")
        ? params.leverage ?? null
        : currentSettings?.leverage ?? null;
      const resolvedProtocol = params.protocol ?? inferLiveProtocol({
        protocol: params.protocol,
        marketType: targetMarketType,
        chainId: resolvedChainId,
        walletNetwork: resolvedWalletNetwork,
      });

      const currentWalletAddress =
        currentSettings?.walletAddress ??
        currentWalletRecord?.wallet_address ??
        null;
      const currentMasterWalletAddress = currentWalletRecord?.master_wallet_address ?? null;

      // Settlement-specific fields (excluding chainId which is needed for both paper and live)
      const settlementSpecificFields = [
        "settlementConfig",
        "walletAddress",
        "symbol",
        "protocol",
      ];
      const settlementConfigFieldKeys = [
        ...settlementSpecificFields,
        "chainId",  // For backwards compatibility in field list
      ];

      // trading-data requires settlement_config only when entering live mode.
      // If the caller supplies settlementConfig on an existing live agent, pass it
      // through as an intentional wallet/config update.
      const settlementConfigRequested = hasOwnField(params, "settlementConfig");
      const walletAddressRequested = hasOwnField(params, "walletAddress");
      const needsSettlementConfig = (currentMode !== "live" && targetMode === "live") || settlementConfigRequested;

      const needsSimulationConfig =
        hasOwnField(params, "simulationConfig") ||
        ((hasOwnField(params, "mode") && targetMode === "paper") ||
          (targetMode === "paper" &&
            (hasOwnField(params, "marketType") ||
              hasOwnField(params, "protocol"))));

      let settlementConfigPayload: Record<string, unknown> | undefined;
      if (needsSettlementConfig && !walletAddressRequested) {
        const missing: string[] = [];
        if (!resolvedMasterWalletAddress) missing.push("settlementConfig.ethAddress");
        if (missing.length > 0) {
          return textResult({
            ...result,
            error: `Cannot transition to live or update settlement_config. Missing fields: ${missing.join(", ")}`,
          });
        }

        settlementConfigPayload = {
          eth_address: resolvedMasterWalletAddress,
          ...(resolvedWalletAddress && resolvedWalletAddress.toLowerCase() !== resolvedMasterWalletAddress.toLowerCase()
            ? { agent_address: resolvedWalletAddress }
            : {}),
        };
      }

      let simulationConfigPayload: Record<string, unknown> | undefined;
      if (needsSimulationConfig) {
        simulationConfigPayload = buildDerivedSimulationConfig({
          symbol: resolvedSymbol ?? undefined,
          marketType: targetMarketType,
          chainId: resolvedChainId,
          protocol: params.protocol,
          patch: params.simulationConfig,
        });
      }

      result.preflight.current = {
        mode: currentMode,
        marketType: currentMarketType,
        symbol: currentSymbol ?? null,
        chainId: currentSettings?.chainId ?? null,
        settlementConfig: currentMasterWalletAddress
          ? {
              ethAddress: currentMasterWalletAddress,
              agentAddress: currentWalletAddress,
            }
          : null,
        leverage: currentSettings?.leverage ?? null,
        isActive: currentSettings?.isActive ?? null,
      };
      result.preflight.target = {
        mode: targetMode,
        marketType: targetMarketType,
        symbol: resolvedSymbol,
        chainId: resolvedChainId,
        initialCapital: params.initialCapital ?? null,
        settlementConfig: resolvedMasterWalletAddress
          ? {
              ethAddress: resolvedMasterWalletAddress,
              agentAddress: resolvedWalletAddress,
            }
          : null,
        protocol: resolvedProtocol ?? null,
        leverage: resolvedLeverage,
      };
      if (settlementConfigPayload) {
        result.preflight.derivedSettlementConfig = settlementConfigPayload;
      }
      if (simulationConfigPayload) {
        result.preflight.derivedSimulationConfig = simulationConfigPayload;
      }

      {
        const body: Record<string, unknown> = {
          id: params.agentId,
          timestamp: signedAt,
        };
        if (hasOwnField(params, "name")) body.name = params.name;
        if (hasOwnField(params, "description")) body.description = params.description;
        if (hasOwnField(params, "avatarUrl")) body.avatarUrl = params.avatarUrl;
        if (hasOwnField(params, "strategy")) body.strategy = params.strategy;
        if (hasOwnField(params, "strategyDescription")) body.strategyDescription = params.strategyDescription;
        if (hasOwnField(params, "isActive")) body.isActive = params.isActive;
        if (hasOwnField(params, "leverage")) body.leverage = params.leverage;
        if (hasOwnField(params, "mode")) body.mode = targetMode;
        if (hasOwnField(params, "marketType")) body.marketType = targetMarketType;
        if (hasOwnField(params, "symbol")) body.symbol = params.symbol;
        if (hasOwnField(params, "chainId")) body.chainId = params.chainId;
        if (hasOwnField(params, "initialCapital")) body.initialCapital = params.initialCapital;
        if (hasOwnField(params, "protocol")) body.protocol = params.protocol;
        if (hasOwnField(params, "walletAddress")) body.wallet_address = params.walletAddress;
        if (settlementConfigPayload) body.settlement_config = settlementConfigPayload;
        if (simulationConfigPayload) body.simulationConfig = simulationConfigPayload;
        if (!hasOwnField(params, "copiedFromAgentId") && hasOwnField(params, "isPrivate")) {
          body.isPrivate = params.isPrivate;
        }
        if (hasOwnField(params, "copiedFromAgentId")) body.copiedFromAgentId = params.copiedFromAgentId;

        debugLog("update_agent", "trading-data.req", { url: `${baseUrl}/api/agent`, body });
        const res = await fetch(`${baseUrl}/api/agent`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
          },
          body: JSON.stringify(body),
        });
        const responseBody = await parseResponseBody(res);
        const ok = res.ok && responseBody?.success !== false;
        result.tradingData = {
          ok,
          status: res.status,
          body: responseBody,
        };
        debugLog("update_agent", "trading-data.res", result.tradingData);
        if (!ok) {
          result.warnings = Array.from(new Set(warnings));
          debugLog("update_agent", "result", result);
          return textResult(result);
        }
      }

      try {
        const [verifySettings, verifyAgent] = await Promise.all([
          fetchAgentSettingsForUpdate(auth, params.agentId),
          fetch(`${baseUrl}/api/agent/${params.agentId}`, {
            headers: { Authorization: auth },
          }).then(async (res) => await parseResponseBody(res)),
        ]);
        result.verify = {
          ok: true,
          settings: verifySettings,
          agent: verifyAgent,
        };
      } catch (e: any) {
        result.verify = {
          ok: false,
          error: e.message,
        };
      }

      result.warnings = Array.from(new Set(warnings));
      debugLog("update_agent", "result", result);
      return textResult(result);
    },
  });

  // ── Composite tools ────────────────────────────────────────────

  api.registerTool({
    name: "init_trading_session",
    description: "Initialize a trading session: check/generate Nostr keys and optionally list wallets (live mode). Replaces sequential calls to get_or_create_nostr_keys + list_wallets. Call this tool directly from the current session; do not delegate it to a subagent or replace it with exec/direct HTTP workarounds.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
    }),
    async execute(_id: string, params: { mode?: string }) {
      const mode = params.mode ?? "paper";
      debugLog("init_trading_session", "entry", { mode });
      const result: Record<string, unknown> = {};

      // Step 1: Check/generate Nostr key
      let pk = pluginConfig.nostrPrivateKey;
      let generated = false;
      if (!pk) {
        pk = Keys.generatePrivateKey();
        persistKeyToConfig(pk);
        pluginConfig.nostrPrivateKey = pk;
        generated = true;
      }
      const publicKey = Keys.getPublicKey(pk);
      const npub = Nip19.npubEncode(publicKey);
      result.keys = { ok: true, npub, publicKey, generated };
      debugLog("init_trading_session", "keys", { npub, generated });

      // Step 2: If live, list wallets
      if (mode === "live") {
        try {
          const auth = getAuthHeader(publicKey, pk);
          const walletsUrl = `${baseUrl}/api/wallets?npub=${npub}`;
          debugLog("init_trading_session", "api.req /api/wallets", { url: walletsUrl });
          const res = await fetch(walletsUrl, {
            headers: { Authorization: auth },
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => null);
            debugLog("init_trading_session", "api.res /api/wallets", { status: res.status, body: errText });
            result.wallets = { ok: false, error: `list_wallets failed: ${res.status}` };
          } else {
            const data = await res.json();
            debugLog("init_trading_session", "api.res /api/wallets", { status: res.status, body: data });
            const wallets = (data.data || [])
              .filter((w: any) => w.is_active && w.wallet_type === "hyperliquid_agent")
              .map((w: any) => ({
                name: w.name,
                walletAddress: w.wallet_address,
                masterWalletAddress: w.master_wallet_address,
                network: w.hyperliquid_network,
              }));
            result.wallets = { ok: true, wallets };
          }
        } catch (e: any) {
          result.wallets = { ok: false, error: e.message };
        }
      }

      debugLog("init_trading_session", "result", result);
      return textResult(result);
    },
  });

  api.registerTool({
    name: "request_hyperliquid_setup_flow",
    description: "Request a Hyperliquid API wallet setup link from trading-data and return a user-friendly message with buttons to open the setup app, copy the link, or refresh the request. This tool replaces the old setup_live_wallet flow, providing a guided wallet registration experience via the hyperliquid-management web app.",
    parameters: Type.Object({
      network: Type.Optional(Type.String({ description: '"testnet" or "mainnet". Defaults to the configured network.' })),
    }),
    async execute(
      _id: string,
      params: { network?: string },
    ) {
      const network = params.network ?? defaultHyperliquidNetwork;
      
      debugLog("request_hyperliquid_setup_flow", "entry", { network });
      const result: Record<string, unknown> = {};

      try {
        const setup = await requestHyperliquidSetupFlow({
          network,
          pluginConfig,
          baseUrl,
          parseResponseBody,
          responseErrorMessage,
          debugLog,
        });

        result.ok = true;
        result.token = setup.token;
        result.network = setup.network;
        result.setupUrl = setup.setupUrl;
        result.expiresAt = setup.expiresAt;
        
        debugLog("request_hyperliquid_setup_flow", "result", result);
        const setupMessage = buildHyperliquidSetupTelegramMessage({ setupUrl: setup.setupUrl, network: setup.network });
        const telegramMessage = await sendTelegramMessage(setupMessage.message, { buttons: setupMessage.keyboard });
        if (telegramMessage.ok) {
          return buildHyperliquidSetupFlowSentResult({
            network: setup.network,
            expiresAt: setup.expiresAt,
            telegramChatId: telegramMessage.chatId,
            telegramMessageId: telegramMessage.messageId,
          });
        }
        
        return buildHyperliquidSetupFlowResult({
          setupUrl: setup.setupUrl,
          token: setup.token,
          network: setup.network,
          expiresAt: setup.expiresAt,
        });
      } catch (e: any) {
        result.ok = false;
        result.error = e.message;
        debugLog("request_hyperliquid_setup_flow", "result", result);
        return textResult(result);
      }
    },
  });


  api.registerTool({
    name: "deploy_agent",
    description: "Create a trading agent. The server handles all downstream trading-bot and settlement syncing internally on POST /api/agent. Call this tool directly from the current session only; do not route it through a subagent, exec, or direct HTTP workaround. Conservative mode: only pass fields explicitly provided by the user, never invent defaults. If required values are missing, ask the user before retrying.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      initialCapital: Type.Optional(Type.Number({ description: "Initial capital amount" })),
      mode: Type.Optional(Type.String({ description: '"paper" or "live". Optional; omit unless specified by the user.' })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp". Optional; when copiedFromAgentId is provided, omit unless user explicitly requests override.' })),
      strategy: Type.Optional(Strategy),
      strategyDescription: Type.Optional(Type.String({ description: "Human-readable strategy summary" })),
      copiedFromAgentId: Type.Optional(Type.Number({ description: "When creating a copy agent, pass the source public agent ID. Required when strategy is omitted. Strategy is resolved automatically; keep other optional fields omitted unless explicitly requested by the user." })),
      walletAddress: Type.Optional(Type.String({ description: "Live wallet selector mapped to wallet_address. Can be a master wallet or agent wallet address in oswap_wallets." })),
      settlementConfig: Type.Optional(Type.Object({
        ethAddress: Type.String({ description: "Master wallet address (maps to settlement_config.eth_address). Required in live mode." }),
        agentAddress: Type.Optional(Type.String({ description: "Agent/API wallet address (maps to settlement_config.agent_address). Optional; backend falls back to ethAddress." })),
      })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
      chainId: Type.Optional(Type.Number({ description: "Network chain ID for both paper and live modes (e.g. Hyperliquid: 998/999, EVM: 1/56). Optional for copy agents unless user explicitly requests override." })),
      leverage: Type.Optional(Type.Number({ description: "Leverage multiplier. Optional for copy agents unless user explicitly requests override." })),
      isPrivate: Type.Optional(Type.Boolean({ description: 'When true, the agent is private and excluded from the public leaderboard. Defaults to false (public). Once an agent is public it cannot be made private again. Copy agents are always private.' })),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        initialCapital?: number;
        mode?: string;
        marketType?: string;
        strategy?: Record<string, unknown>;
        strategyDescription?: string;
        copiedFromAgentId?: number;
        walletAddress?: string;
        settlementConfig?: {
          ethAddress: string;
          agentAddress?: string;
        };
        symbol?: string;
        chainId?: number;
        leverage?: number;
        isPrivate?: boolean;
      },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const isCopyAgent = params.copiedFromAgentId != null;
      if (!params.strategy && !isCopyAgent) {
        return textResult({
          error:
            "strategy is required when copiedFromAgentId is not provided. " +
            "For copy deployment, provide copiedFromAgentId. For direct deployment, provide strategy.",
        });
      }
      if (params.mode == null) {
        return textResult({ error: 'mode is required. Ask the user to choose "paper" or "live".' });
      }
      if (params.mode !== "paper" && params.mode !== "live") {
        return textResult({ error: 'mode must be "paper" or "live"' });
      }
      const mode = params.mode;
      const isLive = mode === "live";
      if (hasOwnField(params, "walletAddress") && hasOwnField(params, "settlementConfig")) {
        return textResult({ error: "Provide either walletAddress or settlementConfig for live wallet selection, not both." });
      }
      if (isLive && hasOwnField(params, "initialCapital")) {
        return textResult({ error: "initialCapital must not be provided for live mode; the server derives it from the wallet balance." });
      }
      let marketType: "spot" | "perp" | undefined;
      let resolvedChainId: number | undefined = params.chainId;
      try {
        if (!isCopyAgent && params.marketType == null) {
          return textResult({ error: 'marketType is required for non-copy agents. Ask the user for "spot" or "perp".' });
        }
        ensureAmmSpotEnabled(mode, params.marketType);
        if (isCopyAgent && params.marketType == null) {
          const sourceAgent = await fetchPublicAgentProfile(params.copiedFromAgentId!);
          marketType = sourceAgent?.marketType === "perp" ? "perp" : "spot";
          ensureAmmSpotEnabled(mode, marketType);
        }
        if (!isCopyAgent && !params.symbol) {
          return textResult({ error: "symbol is required for non-copy agents. Ask the user for the trading pair (for example, ETH/USDC)." });
        }
        if (params.marketType != null) marketType = resolveMarketType(mode, params.marketType);

        if (isLive && marketType === "perp" && resolvedChainId == null && (params.walletAddress || params.settlementConfig?.agentAddress)) {
          try {
            const wallets = await fetchWalletsForUpdate(auth);
            const walletRecord = resolveWalletRecord(wallets, {
              walletAddress: params.walletAddress ?? params.settlementConfig?.agentAddress,
            });
            if (walletRecord?.hyperliquid_network === "testnet") {
              resolvedChainId = 998;
            } else if (walletRecord?.hyperliquid_network === "mainnet") {
              resolvedChainId = 999;
            }
          } catch (e: any) {
            debugLog("deploy_agent", "wallet-network-infer.error", { error: e.message });
          }
        }

        if (isLive && marketType === "perp" && resolvedChainId == null && isCopyAgent) {
          return textResult({
            error:
              "chainId is required for live copied perp agents when wallet network cannot be inferred. " +
              "Provide 998 for Hyperliquid Testnet or 999 for Hyperliquid Mainnet.",
          });
        }

        if (isLive && marketType === "perp" && resolvedChainId != null) {
          resolvedChainId = resolveLiveChainId(resolvedChainId);
        }

        if (resolvedChainId != null && marketType != null) {
          const chainErr = validateChainIdForMarketType(resolvedChainId, marketType);
          if (chainErr) return textResult({ error: chainErr });
        }
        // Crypto agents require a chainId; validate it here so a missing chain
        // fails fast. Copy agents are exempt — trading-data resolves the chain
        // from the source agent.
        if (!isCopyAgent && resolvedChainId == null) {
          return textResult({ error: `chainId is required: ${SPOT_ALLOWED_CHAIN_IDS.join(", ")} for spot, ${PERP_ALLOWED_CHAIN_IDS.join(", ")} for perp.` });
        }
        if (isLive && !params.walletAddress && !params.settlementConfig?.ethAddress) {
          return textResult({ error: "walletAddress or settlementConfig.ethAddress is required for live mode" });
        }
      } catch (e: any) {
        return textResult({ error: e.message });
      }
      debugLog("deploy_agent", "entry", { ...params, usesNostrPrivateKey: true });
      const result: Record<string, unknown> = {};

      let initialCapital = params.initialCapital;
      if (initialCapital == null && !isCopyAgent && !isLive) {
        return textResult({ error: "initialCapital is required for paper mode" });
      }

      const leverage = params.leverage;
      const walletAddress = params.walletAddress;
      const settlementConfig = isLive && params.settlementConfig?.ethAddress
        ? {
            eth_address: params.settlementConfig.ethAddress,
            ...(params.settlementConfig.agentAddress ? { agent_address: params.settlementConfig.agentAddress } : {}),
          }
        : undefined;
      debugLog("deploy_agent", "computed", { walletAddress, settlementConfig });

      // Step 1: Create agent (fatal if fails)
      let agentId: number;
      let agentUrl: string;
      const creationTimestamp = new Date().toISOString();
      try {
        const payload: Record<string, unknown> = {
          name: params.name,
          mode,
          owner: npub,
        };
        if (initialCapital != null) payload.initialCapital = initialCapital;
        if (params.marketType != null) payload.marketType = marketType;
        if (leverage != null) payload.leverage = leverage;
        if (resolvedChainId != null) payload.chainId = resolvedChainId;
        payload.assetType = "crypto";
        if (params.strategy) payload.strategy = params.strategy;
        if (params.strategyDescription) payload.strategyDescription = params.strategyDescription;
        if (params.copiedFromAgentId != null) payload.copiedFromAgentId = params.copiedFromAgentId;
        if (params.symbol) payload.symbol = params.symbol;
        if (walletAddress) payload.wallet_address = walletAddress;
        else if (settlementConfig) payload.settlement_config = settlementConfig;
        if (!isCopyAgent && hasOwnField(params, "isPrivate")) payload.isPrivate = params.isPrivate;

        debugLog("deploy_agent", "create.api.req POST /api/agent", payload);
        const res = await fetch(`${baseUrl}/api/agent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errText = await res.text();
          debugLog("deploy_agent", "create.api.res", { status: res.status, error: errText });
          result.create = { ok: false, error: `create_agent failed: ${res.status} ${errText}` };
          return textResult(result);
        }
        const data = await res.json();
        agentId = data.agentId;
        agentUrl = `${webUrl}/trading-agents/${publicKey}/${agentId}`;
        debugLog("deploy_agent", "create.api.res", { status: res.status, body: data });
        result.create = { ok: true, agentId, agentUrl, createdAt: creationTimestamp };
      } catch (e: any) {
        result.create = { ok: false, error: e.message };
        return textResult(result);
      }

      // Step 2: Verify
      try {
        const res = await fetch(`${baseUrl}/api/agent/${agentId}`, {
          headers: { Authorization: auth },
        });
        const verifyBody = await res.json().catch(() => null);
        debugLog("deploy_agent", "verify.api.res GET /api/agent", { status: res.status, body: verifyBody });
        if (res.ok) {
          result.verify = { ok: true, agent: verifyBody };
        } else {
          result.verify = { ok: false };
        }
      } catch {
        result.verify = { ok: false };
      }

      if (result.verify && !(result.verify as { ok?: boolean }).ok) {
        result.error = result.error ?? "Agent creation completed but verification failed";
        result.success = false;
        const validAgentId = typeof (agentId as any) === 'number' && !Number.isNaN(agentId as any);
        if (!validAgentId) {
          // Server returned 200 but no agentId — agent does not exist; null out misleading fields
          (result.create as any).ok = false;
          (result.create as any).agentId = null;
          (result.create as any).agentUrl = null;
          result.agentId = null;
          result.criticalNote =
            "NO_AGENT_CREATED: The server did not return a valid agent ID. No agent was confirmed to exist. " +
            "Do NOT tell the user an agent was successfully created. " +
            "Do NOT fabricate or guess an agent ID. " +
            "Report this as a failure and ask the user to try again.";
        } else {
          result.agentId = agentId;
          result.criticalNote =
            `UNVERIFIED_AGENT: Agent ID ${agentId} was assigned by the server but could not be immediately confirmed. ` +
            `Inform the user that creation was submitted with ID ${agentId} but verification is pending. ` +
            `Advise them to run list_my_agents to confirm before using the agent.`;
        }
      }

      debugLog("deploy_agent", "result", result);
      return textResult(result);
    },
  });


  api.registerTool({
    name: "search_public_agents",
    description: "Search public trading agents by name using /api/agents/search. Use this when a user references an agent by name but the source agent ID is unknown. Call it directly from the current session and continue any follow-on plugin tool calls in that same session; do not delegate the search or the next tool call to a subagent.",
    parameters: Type.Object({
      query: Type.String({ description: "Agent name or partial name to search" }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default 10)", default: 10 })),
    }),
    async execute(_id: string, params: { query: string; limit?: number }) {
      const q = params.query?.trim();
      if (!q) {
        return textResult({ error: "query is required" });
      }
      const limit = params.limit != null ? Math.max(1, Math.floor(params.limit)) : 10;
      const qs = new URLSearchParams({ q, limit: String(limit) });
      const res = await fetch(`${baseUrl}/api/agents/search?${qs.toString()}`);
      const body = await parseResponseBody(res);
      if (!res.ok) {
        return textResult({
          error: `search_public_agents failed: ${res.status} ${responseErrorMessage(body)}`,
          query: q,
        });
      }
      const rows = Array.isArray(body?.data) ? body.data : [];
      return textResult({
        query: q,
        count: rows.length,
        data: rows,
      });
    },
  });


  // ── List & delete tools ────────────────────────────────────────────

  api.registerTool({
    name: "list_my_agents",
    description: "List all trading agents owned by the current user",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: '"live" or "paper"' })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"' })),
      page: Type.Optional(Type.Number({ description: "Page number (default 1)" })),
      pageSize: Type.Optional(Type.Number({ description: "Results per page" })),
    }),
    async execute(_id: string, params: { mode?: string; marketType?: string; page?: number; pageSize?: number }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const qs = new URLSearchParams();
      if (params.mode) qs.set("mode", params.mode);
      if (params.marketType) qs.set("marketType", params.marketType);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      const url = `${baseUrl}/api/my-agents${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`list_my_agents failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "delete_agent",
    description: "Delete a trading agent by ID. The server delegates removal to trading-bot and settlement engine internally via DELETE /api/agent/:id.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to delete" }),
    }),
    async execute(_id: string, params: { agentId: number }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const result: Record<string, unknown> = {};
      const signedAt = Math.floor(Date.now() / 1000);
      debugLog("delete_agent", "entry", { agentId: params.agentId });

      // Fetch agent to determine mode
      const agentRes = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
        headers: { Authorization: auth },
      });
      if (!agentRes.ok) return textResult({ error: `Agent ${params.agentId} not found: ${agentRes.status}` });
      await agentRes.json();

      // Step 1: Delete from trading-data (delegates to trading-bot and settlement engine)
      try {
        const res = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
          },
          body: JSON.stringify({ timestamp: signedAt }),
        });
        debugLog("delete_agent", "trading-data.res", { status: res.status });
        result.tradingData = { ok: res.ok };
      } catch (e: any) {
        result.tradingData = { ok: false, error: e.message };
      }

      debugLog("delete_agent", "result", result);
      return textResult(result);
    },
  });

  api.registerTool({
    name: "list_wallets",
    description: "List all wallets registered to the current user",
    parameters: Type.Object({}),
    async execute() {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/wallets?npub=${Nip19.npubEncode(publicKey)}`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`list_wallets failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "delete_wallet",
    description: "Delete a wallet by address. Removes from TEE storage and trading-data.",
    parameters: Type.Object({
      walletAddress: Type.String({ description: "Wallet address (0x...) to delete" }),
    }),
    async execute(_id: string, params: { walletAddress: string }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const npub = Nip19.npubEncode(publicKey);
      const auth = getAuthHeader(publicKey, privateKey);
      const result: Record<string, unknown> = {};
      const signedAt = Math.floor(Date.now() / 1000);
      debugLog("delete_wallet", "entry", { walletAddress: params.walletAddress });

      // Remove from trading-data (server always also removes from TEE)
      try {
        const createdAt = signedAt;
        const res = await fetch(`${baseUrl}/api/wallets`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ npub, walletAddress: params.walletAddress, createdAt, agents: [], walletAgentSignedAt: signedAt }),
        });
        debugLog("delete_wallet", "trading-data.res", { status: res.status });
        result.tradingData = { ok: res.ok };
      } catch (e: any) {
        result.tradingData = { ok: false, error: e.message };
      }

      debugLog("delete_wallet", "result", result);
      return textResult(result);
    },
  });

  api.registerTool({
    name: "update_wallet",
    description: "Update a wallet by address. Supports renaming and Hyperliquid wallet metadata changes.",
    parameters: Type.Object({
      walletAddress: Type.String({ description: "Wallet address (0x...) to update" }),
      name: Type.Optional(Type.String({ description: "Optional display name" })),
      walletType: Type.Optional(Type.Union([
        Type.Literal("regular"),
        Type.Literal("hyperliquid_agent"),
      ], { description: "Optional wallet type update" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Required when updating a Hyperliquid agent wallet" })),
      hyperliquidNetwork: Type.Optional(Type.Union([
        Type.Literal("mainnet"),
        Type.Literal("testnet"),
      ], { description: "Required when updating a Hyperliquid agent wallet" })),
    }),
    async execute(_id: string, params: {
      walletAddress: string;
      name?: string;
      walletType?: "regular" | "hyperliquid_agent";
      masterWalletAddress?: string;
      hyperliquidNetwork?: "mainnet" | "testnet";
    }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const npub = Nip19.npubEncode(publicKey);
      const auth = getAuthHeader(publicKey, privateKey);
      const signedAt = Math.floor(Date.now() / 1000);
      const result: Record<string, unknown> = {};
      debugLog("update_wallet", "entry", params);

      try {
        const body = {
          npub,
          walletAddress: params.walletAddress,
          ...(params.name !== undefined && { name: params.name }),
          ...(params.walletType !== undefined && { walletType: params.walletType }),
          ...(params.masterWalletAddress !== undefined && { masterWalletAddress: params.masterWalletAddress }),
          ...(params.hyperliquidNetwork !== undefined && { hyperliquidNetwork: params.hyperliquidNetwork }),
          walletAgentSignedAt: signedAt,
        };
        debugLog("update_wallet", "trading-data.req", body);
        const res = await fetch(`${baseUrl}/api/wallets`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(body),
        });
        const resBody = await parseResponseBody(res);
        debugLog("update_wallet", "trading-data.res", { status: res.status, body: resBody });
        if (!res.ok) {
          throw new Error(`update_wallet failed: ${res.status} ${responseErrorMessage(resBody)}`);
        }
        result.tradingData = { ok: true, body: resBody };
      } catch (e: any) {
        result.tradingData = { ok: false, error: e.message };
      }

      debugLog("update_wallet", "result", result);
      return textResult(result);
    },
  });

  // ── Backtest tools ──────────────────────────────────────────────

  api.registerTool({
    name: "create_backtest",
    description:
      "Create a new backtest job from an inline strategy. " +
      "If the user mentions a timezone, OpenClaw should resolve it before calling the tool. " +
      "If `startTime` and/or `endTime` are omitted, the plugin defaults to a rolling 30-day window.",
    parameters: Type.Object({
      initialCapital: Type.Number({ description: "Initial capital amount" }),
      strategy: Strategy,
      startTime: Type.Optional(Type.Union([
        Type.String({
          description:
            "Optional start time (ISO datetime, date-only YYYY-MM-DD, or unix timestamp). If omitted, the plugin derives it from `endTime` or defaults to a rolling 30-day window.",
        }),
        Type.Number({
          description:
            "Optional start unix timestamp in seconds or milliseconds.",
        }),
      ])),
      endTime: Type.Optional(Type.Union([
        Type.String({
          description:
            "Optional end time (ISO datetime, date-only YYYY-MM-DD, or unix timestamp). Date-only end dates include the full final local day. If omitted, the plugin derives it from `startTime` or defaults to a rolling 30-day window.",
        }),
        Type.Number({
          description:
            "Optional end unix timestamp in seconds or milliseconds.",
        }),
      ])),
      timeZone: Type.Optional(
        Type.String({
          description:
            'Optional resolved timezone for the requested range, e.g. "Asia/Hong_Kong", "Hong Kong time", or "Toronto time". Pass this whenever OpenClaw inferred a timezone phrase from the user so the tool interprets the request consistently, even if start/end already include explicit offsets.',
        }),
      ),
      protocolFee: Type.Optional(Type.Number({ description: "Protocol fee override" })),
      gasFee: Type.Optional(Type.Number({ description: "Gas fee override" })),
    }),
    async execute(
      _id: string,
      params: {
        initialCapital: number;
        strategy: Record<string, unknown>;
        startTime?: string | number;
        endTime?: string | number;
        timeZone?: string;
        protocolFee?: number;
        gasFee?: number;
      },
    ) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);

      const normalizedRange = normalizeBacktestTimeRange(
        params.startTime,
        params.endTime,
        params.timeZone,
      );
      debugLog("create_backtest", "normalized-range", {
        timeZoneSource: normalizedRange.timeZoneSource,
        timeZoneUsed: normalizedRange.timeZoneUsed,
        input: {
          startTime: params.startTime,
          endTime: params.endTime,
          timeZone: params.timeZone,
        },
        normalized: {
          startTime: normalizedRange.startTime,
          endTime: normalizedRange.endTime,
        },
      });

      const payload: Record<string, unknown> = {
        initialCapital: params.initialCapital,
        strategy: params.strategy,
        startTime: normalizedRange.startTime,
        endTime: normalizedRange.endTime,
      };
      if (params.protocolFee != null) payload.protocolFee = params.protocolFee;
      if (params.gasFee != null) payload.gasFee = params.gasFee;

      const res = await fetch(`${baseUrl}/api/backtest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify(payload),
      });
      const body = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(`create_backtest failed: ${res.status} ${responseErrorMessage(body)}`);
      }

      const responseBody =
        typeof body === "object" && body !== null
          ? { ...(body as Record<string, unknown>) }
          : {};
      const jobId =
        typeof responseBody.jobId === "string"
          ? responseBody.jobId
          : typeof responseBody.job_id === "string"
            ? responseBody.job_id
            : typeof responseBody.data === "object" &&
                responseBody.data !== null &&
                typeof (responseBody.data as Record<string, unknown>).jobId === "string"
              ? (responseBody.data as Record<string, unknown>).jobId
              : typeof responseBody.data === "object" &&
                  responseBody.data !== null &&
                  typeof (responseBody.data as Record<string, unknown>).job_id === "string"
                ? (responseBody.data as Record<string, unknown>).job_id
                : null;

      if (!jobId) {
        throw new Error("create_backtest succeeded but response did not include a jobId");
      }

      const topLevelEta =
        typeof responseBody.eta === "object" && responseBody.eta !== null
          ? responseBody.eta as Record<string, unknown>
          : null;
      const nestedEta =
        typeof responseBody.data === "object" &&
        responseBody.data !== null &&
        typeof (responseBody.data as Record<string, unknown>).eta === "object" &&
        (responseBody.data as Record<string, unknown>).eta !== null
          ? (responseBody.data as Record<string, unknown>).eta as Record<string, unknown>
          : null;
      const etaMs = typeof topLevelEta?.ms === "number"
        ? topLevelEta.ms
        : typeof nestedEta?.ms === "number"
          ? nestedEta.ms
          : null;
      const eta = etaMs != null && Number.isFinite(etaMs)
        ? { ms: Math.max(0, Math.trunc(etaMs)) }
        : undefined;

      return textResult({
        ...responseBody,
        jobId,
        ...(eta ? { eta } : {}),
        status: "submitted",
        message: `Backtest job ${jobId} submitted.`,
      });
    },
  });

  api.registerTool({
    name: "get_backtests",
    description: "List manual backtests for the authenticated user",
    parameters: Type.Object({}),
    async execute(_id: string) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);

      const res = await fetch(`${baseUrl}/api/backtests`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`get_backtests failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_backtest_job",
    description: "Poll the progress and status of a backtest job",
    parameters: Type.Object({
      jobId: Type.String({ description: "Backtest job ID" }),
    }),
    async execute(_id: string, params: { jobId: string }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/backtest-job/${params.jobId}`, {
        headers: { Authorization: auth },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`get_backtest_job failed: ${res.status} ${responseErrorMessage(body)}`);
      return textResult(body);
    },
  });

  api.registerTool({
    name: "get_backtest_result",
    description:
      "Get the result of a completed backtest job. " +
      "Mode 'detail' returns portfolio, metrics, and trades. " +
      "Mode 'link' returns only a URL to the agent's web page (requires agentId).",
    parameters: Type.Object({
      jobId: Type.String({ description: "Backtest job ID" }),
      mode: Type.Optional(Type.Union([
        Type.Literal("detail"),
        Type.Literal("link"),
      ], { default: "detail", description: "'detail' returns portfolio, metrics, and all trades. 'link' returns only a URL to the backtest's agent page on agent.openswap.xyz." })),
      agentId: Type.Optional(Type.Number({ description: "Agent ID. Required when mode is 'link'. Pass the agent the backtest belongs to (taken from conversation context or asked from the user)." })),
    }),
    async execute(_id: string, params: { jobId: string; mode?: "detail" | "link"; agentId?: number }) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/backtest-job/${params.jobId}/result`, {
        headers: { Authorization: auth },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`get_backtest_result failed: ${res.status} ${responseErrorMessage(body)}`);
      return textResult(sanitizeBacktestResultResponse(body, params.jobId, {
        mode: params.mode,
        npub,
        agentId: params.agentId,
        webUrl,
      }));
    },
  });

  // ── Backtest leaderboard ─────────────────────────────────────────

  api.registerTool({
    name: "backtest_leader_board",
    description:
      "Get the backtest leaderboard showing top-performing agents ranked by return percentage. " +
      "Specify a period (1d, 1w, 1m) and optional limit. " +
      "Each entry includes the leaderboard agent ID as `agent_id` (also mirrored as `agentId`) and the auto-backtest job ID as `job_id` (also mirrored as `jobId`). " +
      "When presenting leaderboard results, always include the agent ID next to the agent name so the user can refer to a specific agent in follow-up requests. " +
      "Pass the job ID to `get_backtest_result` to fetch the full run detail.",
    parameters: Type.Object({
      period: Type.Union([
        Type.Literal("1d"),
        Type.Literal("1w"),
        Type.Literal("1m"),
      ], { description: "Backtest period: 1d (daily), 1w (weekly), 1m (monthly)" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10, description: "Number of top agents to return (default 10, max 50)" })),
      chain: Type.Optional(Type.Number({ description: "Filter by blockchain chain ID (e.g., 1 for Ethereum, 56 for BSC)" })),
      pair: Type.Optional(Type.String({ description: "Filter by trading pair symbol (e.g., 'ETH/USDC')" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("live"),
        Type.Literal("paper"),
      ], { description: "Filter by trading mode: live or paper" })),
      marketType: Type.Optional(Type.Union([
        Type.Literal("spot"),
        Type.Literal("perp"),
      ], { description: "Filter by market type: spot or perp" })),
    }),
    async execute(_id: string, params: { period: string; limit?: number; chain?: number; pair?: string; mode?: string; marketType?: string }) {
      const limit = params.limit ?? 10;
      const url = new URL(`${baseUrl}/api/backtest-leaderboard`);
      url.searchParams.append('period', params.period);
      url.searchParams.append('limit', limit.toString());
      if (params.chain !== undefined) url.searchParams.append('chain', params.chain.toString());
      if (params.pair !== undefined) url.searchParams.append('pair', params.pair);
      if (params.mode !== undefined) url.searchParams.append('mode', params.mode);
      if (params.marketType !== undefined) url.searchParams.append('marketType', params.marketType);

      const res = await fetch(url.toString());
      const body = await res.json();
      if (!res.ok) throw new Error(`backtest_leader_board failed: ${res.status} ${responseErrorMessage(body)}`);

      const rows = Array.isArray(body?.data) ? body.data : [];
      const data = rows.map((row: any) => {
        if (typeof row !== "object" || row === null) return row;

        return {
          ...row,
          agentId:
            typeof row.agentId === "number"
              ? row.agentId
              : typeof row.agent_id === "number"
                ? row.agent_id
                : undefined,
          jobId:
            typeof row.jobId === "string"
              ? row.jobId
              : typeof row.job_id === "string"
                ? row.job_id
                : undefined,
        };
      });

      return textResult({
        ...body,
        data,
        presentationHint:
          "When listing leaderboard results, include each agent's ID together with the name, for example: Agent 3027 - Trend Follower.",
      });
    },
  });

  // ── Nostr DM notifications ───────────────────────────────────────
  registerNostrNotifications(api, pluginConfig, debugLog);
}
