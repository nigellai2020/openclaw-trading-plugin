import { Type } from "@sinclair/typebox";
import { Crypto, Keys, Nip19, Signer } from "@scom/scom-signer";
import { Contract, Wallet } from "ethers";
import {
  DEFAULT_LIVE_LEVERAGE,
  ERC20_ABI,
  getEvmChainConfig,
  NFT_ABI,
  ROUTER_ABI,
  VAULT_ABI,
} from "../constants/trading.js";
import {
  createToolsContext,
  type ToolsContext,
} from "../context/create-tools-context.js";
import { CopyTradeOrderConfig, SimulationConfig, SimulationConfigPatch, Strategy } from "../schemas/strategy.js";
import { registerFillNotifications } from "./register-fill-notifications.js";
import type { EthHeaders, PreparedAgentCreationContext } from "../types/billing.js";
import { getAuthHeader, loadKeys, persistKeyToConfig } from "../utils/auth.js";
import { sanitizeBacktestResultResponse } from "../utils/backtest-result.js";
import { normalizeBacktestTimeRange } from "../utils/backtest-time.js";
import { formatAmount } from "../utils/billing.js";
import { deriveDefaultLiveBuyLimit, fetchEvmWalletBalances, fetchUsdcBalance, textResult } from "../utils/live-trading.js";
import { fetchSupportedPairsFromApi } from "../utils/supported-pairs.js";
import { decideUpdateAgentBilling, type UpdateAgentBillingRequirement } from "../update-agent-billing.js";

type AgentTradeRange = "12h" | "24h" | "1d" | "3d" | "7d" | "30d" | "all";
type TokenPriceValidationIssue = {
  index: number;
  symbol: string;
  reason: string;
};

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

export default function registerTools(api: any, ctx: ToolsContext = createToolsContext(api)) {
  const {
    pluginConfig,
    baseUrl,
    tradingBotUrl,
    walletAgentUrl,
    settlementEngineUrl,
    billingEvmConfig,
    debugLog,
    responseErrorMessage,
    resolveMarketType,
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
    buildAgentActionSignature,
    buildWalletActionSignature,
    fetchPublicAgentProfile,
    fetchSettlementProtocolName,
    buildBillingWallet,
    buildBillingHeaders,
    ensureBillingWalletRegistered,
    fetchBillingBypassStatus,
    fetchBillingBalanceSnapshot,
    fetchBillingSubscriptions,
    fetchBillingSubscriptionsSnapshot,
    prepareAgentCreationContext,
    waitForVaultCredit,
  } = ctx;


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
      "Returns crypto pairs with venue availability and stock symbols (paper mode, signal simulation only). " +
      "Use optional filters to narrow results by asset type or protocol.",
    parameters: Type.Object({
      assetType: Type.Optional(
        Type.String({ description: '"crypto" or "stocks". Omit for all.' }),
      ),
      protocol: Type.Optional(
        Type.String({
          description:
            '"uniswap", "hyperliquid", or "signal_simulation". Filters to pairs available on this protocol. Omit for all.',
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { assetType?: string; protocol?: string },
    ) {
      let results = await fetchSupportedPairsFromApi(baseUrl);

      if (params.assetType) {
        results = results.filter((p) => p.asset_type === params.assetType);
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
    name: "get_leaderboard",
    description: "Get the trading agent leaderboard with optional pagination and filters",
    parameters: Type.Object({
      page: Type.Optional(Type.Number({ description: "Page number (default 1)" })),
      pageSize: Type.Optional(Type.Number({ description: "Results per page" })),
      query: Type.Optional(Type.String({ description: "Text search on agent name" })),
      chain: Type.Optional(Type.Number({ description: "Chain ID filter" })),
      pair: Type.Optional(Type.Number({ description: "Trading pair ID filter" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("live"),
        Type.Literal("paper"),
      ], { description: 'Trading mode filter: "live" or "paper"' })),
      marketType: Type.Optional(Type.Union([
        Type.Literal("spot"),
        Type.Literal("perp"),
      ], { description: 'Market type filter: "spot" or "perp"' })),
    }),
    async execute(
      _id: string,
      params: {
        page?: number;
        pageSize?: number;
        query?: string;
        chain?: number;
        pair?: number;
        mode?: "live" | "paper";
        marketType?: "spot" | "perp";
      },
    ) {
      const qs = new URLSearchParams();
      if (params.page != null) qs.set("page", String(params.page));
      if (params.pageSize != null) qs.set("pageSize", String(params.pageSize));
      if (params.query) qs.set("query", params.query);
      if (params.chain != null) qs.set("chain", String(params.chain));
      if (params.pair != null) qs.set("pair", String(params.pair));
      if (params.mode) qs.set("mode", params.mode);
      if (params.marketType) qs.set("marketType", params.marketType);

      const url = `${baseUrl}/api/leaderboard${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`get_leaderboard failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_leaderboard_filters",
    description: "Get available leaderboard filter values for chains, pairs, modes, and market types",
    parameters: Type.Object({}),
    async execute() {
      const res = await fetch(`${baseUrl}/api/leaderboard/filters`);
      if (!res.ok) throw new Error(`get_leaderboard_filters failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_agent_trades",
    description: "Get past trades and trade history for a single agent, with optional pagination, type, and either a relative range like 1d/7d or explicit start/end timestamps",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID" }),
      type: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("entry"),
        Type.Literal("exit"),
      ], { description: 'Trade type filter: "all", "entry", or "exit"' })),
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
      pageSize: Type.Optional(Type.Number({ description: "Results per page" })),
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

      const url = `${baseUrl}/api/transactions/${params.agentId}${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`get_agent_trades failed: ${res.status}`);
      return textResult(await res.json());
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
    description: "Get USDC balance of a Hyperliquid master wallet (public endpoint, no auth needed). Use the master wallet address, not the agent/API wallet.",
    parameters: Type.Object({
      masterWalletAddress: Type.String({ description: "Master wallet address (0x...), not the agent/API wallet" }),
      chainId: Type.Optional(Type.Number({ description: "998=testnet, 999=mainnet", default: 998 })),
    }),
    async execute(
      _id: string,
      params: { masterWalletAddress: string; chainId?: number },
    ) {
      const chainId = params.chainId ?? 998;
      const balance = await fetchUsdcBalance(params.masterWalletAddress, chainId);

      if (balance > 0) {
        return textResult({ masterWalletAddress: params.masterWalletAddress, chainId, balance });
      } else {
        const appUrl = chainId === 999
          ? "https://app.hyperliquid.xyz"
          : "https://app.hyperliquid-testnet.xyz";
        return textResult({
          masterWalletAddress: params.masterWalletAddress,
          chainId,
          balance,
          depositReminder:
            `Your wallet has 0 USDC balance. You must deposit USDC into your Hyperliquid wallet before you can trade. ` +
            `Deposit here: ${appUrl}`,
        });
      }
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
    name: "get_billing_subscriptions",
    description: "List billing subscriptions for the billing wallet derived from nostrPrivateKey. Automatically ensures the billing wallet is registered before fetching subscriptions.",
    parameters: Type.Object({}),
    async execute() {
      const { privateKey, npub, publicKey } = loadKeys(pluginConfig);
      const billingWallet = buildBillingWallet();
      debugLog("get_billing_subscriptions", "entry", {
        walletAddress: billingWallet.address,
        usesNostrPrivateKey: true,
      });
      try {
        const registration = await ensureBillingWalletRegistered({
          npub,
          publicKey,
          privateKey,
          wallet: billingWallet,
        });
        const { subscriptions, walletRegistered } = await fetchBillingSubscriptionsSnapshot(billingWallet);
        const result = {
          walletAddress: billingWallet.address,
          walletRegistered,
          billingWalletRegistration: registration,
          subscriptions,
        };
        debugLog("get_billing_subscriptions", "result", result);
        return textResult(result);
      } catch (e: any) {
        return textResult({
          walletAddress: billingWallet.address,
          walletRegistered: false,
          error: e.message,
        });
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
      const res = await fetch(`${baseUrl}/api/agent/${params.agentId}`);
      if (!res.ok) throw new Error(`get_agent failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "update_agent",
    description: "Update a trading agent via PUT /api/agent with delegateToTradingBot and delegateToSettlement flags so the server handles all downstream syncing. Only explicitly provided fields are updated.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to update" }),
      name: Type.Optional(Type.String({ description: "Updated agent name" })),
      description: Type.Optional(Type.String({ description: "Updated agent description" })),
      avatarUrl: Type.Optional(Type.String({ description: "Updated avatar URL" })),
      strategy: Type.Optional(Strategy),
      strategyDescription: Type.Optional(Type.String({ description: "Updated human-readable strategy description" })),
      isActive: Type.Optional(Type.Boolean({ description: "Enable or disable the agent" })),
      leverage: Type.Optional(Type.Number({ description: "Updated leverage multiplier" })),
      strategyFeePerPeriod: Type.Optional(Type.Union([
        Type.Number({ description: "Updated strategy fee per billing period" }),
        Type.Null(),
      ])),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"' })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"' })),
      symbol: Type.Optional(Type.String({ description: 'Updated trader symbol, e.g. "ETH/USDC"' })),
      chainId: Type.Optional(Type.Number({ description: "Updated settlement/simulation chain ID" })),
      protocol: Type.Optional(Type.String({ description: 'Updated protocol, e.g. "hyperliquid" or "uniswap_v3"' })),
      buyLimit: Type.Optional(Type.Number({ description: "Updated live-trading buy limit in USD" })),
      walletId: Type.Optional(Type.Number({ description: "Wallet ID to resolve walletAddress/masterWalletAddress from" })),
      walletAddress: Type.Optional(Type.String({ description: "Updated agent/API wallet address" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Updated master wallet address used by settlement" })),
      simulationConfig: Type.Optional(SimulationConfigPatch),
      positionQty: Type.Optional(Type.Number({ description: "Updated settlement position quantity" })),
      slippage: Type.Optional(Type.Number({ description: "Updated settlement slippage tolerance" })),
      expiration: Type.Optional(Type.Number({ description: "Updated settlement transaction expiration in seconds" })),
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
        strategyFeePerPeriod?: number | null;
        mode?: string;
        marketType?: string;
        symbol?: string;
        chainId?: number;
        protocol?: string;
        buyLimit?: number;
        walletId?: number;
        walletAddress?: string;
        masterWalletAddress?: string;
        simulationConfig?: {
          asset_type?: string;
          protocol?: string;
          chain_id?: number;
        };
        positionQty?: number;
        slippage?: number;
        expiration?: number;
      },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
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
        "strategyFeePerPeriod",
        "mode",
        "marketType",
        "symbol",
        "chainId",
        "protocol",
        "buyLimit",
        "walletId",
        "walletAddress",
        "masterWalletAddress",
        "simulationConfig",
        "positionQty",
        "slippage",
        "expiration",
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
      if (
        params.simulationConfig?.asset_type != null &&
        params.simulationConfig.asset_type !== "crypto" &&
        params.simulationConfig.asset_type !== "stocks"
      ) {
        return textResult({ error: 'simulationConfig.asset_type must be "crypto" or "stocks"' });
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
          fetch(`${baseUrl}/api/agent/${params.agentId}`)
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

      const currentWalletRecord = resolveWalletRecord(wallets, {
        walletId: currentSettings?.walletId,
        walletAddress: currentSettings?.walletAddress,
      });
      const requestedWalletRecord = resolveWalletRecord(wallets, {
        walletId: params.walletId,
        walletAddress: params.walletAddress,
      });
      if (params.walletId != null && !requestedWalletRecord) {
        return textResult({
          ...result,
          error: `walletId ${params.walletId} was not found in the current wallet list`,
        });
      }
      if (
        params.walletId != null &&
        params.walletAddress &&
        requestedWalletRecord &&
        normalizeAddress(requestedWalletRecord.wallet_address) !== normalizeAddress(params.walletAddress)
      ) {
        return textResult({
          ...result,
          error: "walletId and walletAddress refer to different wallets",
        });
      }

      const resolvedWalletRecord = requestedWalletRecord ?? currentWalletRecord;
      const nextStrategy = hasOwnField(params, "strategy") ? params.strategy : currentSettings?.strategy;
      const currentSymbol = inferSymbolFromStrategy(currentSettings?.strategy);
      const resolvedSymbol = params.symbol ?? inferSymbolFromStrategy(nextStrategy) ?? currentSymbol ?? null;
      const resolvedChainId = hasOwnField(params, "chainId") ? params.chainId ?? null : currentSettings?.chainId ?? null;
      const resolvedWalletId = hasOwnField(params, "walletId") ? params.walletId ?? null : currentSettings?.walletId ?? null;
      const resolvedWalletAddress =
        params.walletAddress ??
        requestedWalletRecord?.wallet_address ??
        currentSettings?.walletAddress ??
        currentWalletRecord?.wallet_address ??
        null;
      const resolvedMasterWalletAddress =
        params.masterWalletAddress ??
        requestedWalletRecord?.master_wallet_address ??
        currentWalletRecord?.master_wallet_address ??
        null;
      const resolvedWalletNetwork =
        requestedWalletRecord?.hyperliquid_network ??
        currentWalletRecord?.hyperliquid_network ??
        null;
      const resolvedBuyLimit = hasOwnField(params, "buyLimit")
        ? params.buyLimit ?? null
        : currentSettings?.buyLimit ?? null;
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

      const mainFieldKeys = [
        "name",
        "description",
        "avatarUrl",
        "strategy",
        "strategyDescription",
        "isActive",
        "leverage",
        "strategyFeePerPeriod",
      ];
      const settlementConfigFieldKeys = [
        "walletId",
        "walletAddress",
        "masterWalletAddress",
        "symbol",
        "chainId",
        "protocol",
        "buyLimit",
      ];

      if (hasOwnField(params, "walletId")) {
        warnings.push("walletId is used only to resolve walletAddress/masterWalletAddress; there is no direct walletId update endpoint for agents.");
      }

      const needsSettlementConfig =
        settlementConfigFieldKeys.some((field) => hasOwnField(params, field)) ||
        (hasOwnField(params, "mode") && targetMode === "live") ||
        (hasOwnField(params, "marketType") && targetMode === "live");

      const needsSimulationConfig =
        hasOwnField(params, "simulationConfig") ||
        ((hasOwnField(params, "mode") && targetMode === "paper") ||
          (targetMode === "paper" &&
            (hasOwnField(params, "marketType") ||
              hasOwnField(params, "chainId") ||
              hasOwnField(params, "protocol"))));

      let settlementConfigPayload: Record<string, unknown> | undefined;
      if (needsSettlementConfig) {
        const missing: string[] = [];
        if (!resolvedWalletAddress) missing.push("walletAddress");
        if (!resolvedMasterWalletAddress) missing.push("masterWalletAddress");
        if (!resolvedSymbol) missing.push("symbol");
        if (resolvedChainId == null) missing.push("chainId");
        if (resolvedBuyLimit == null) missing.push("buyLimit");
        if (missing.length > 0) {
          return textResult({
            ...result,
            error: `Cannot update settlement_config safely. Missing companion fields: ${missing.join(", ")}`,
          });
        }

        settlementConfigPayload = {
          eth_address: resolvedMasterWalletAddress,
          agent_address: resolvedWalletAddress,
          symbol: resolvedSymbol,
          chain_id: resolvedChainId,
          buy_limit_usd: resolvedBuyLimit,
        };
        if (resolvedProtocol) {
          settlementConfigPayload.protocol = resolvedProtocol;
        } else {
          warnings.push("protocol was not provided or inferable for settlement_config and will be omitted.");
        }
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
        walletId: currentSettings?.walletId ?? null,
        walletAddress: currentWalletAddress,
        masterWalletAddress: currentMasterWalletAddress,
        buyLimit: currentSettings?.buyLimit ?? null,
        leverage: currentSettings?.leverage ?? null,
        isActive: currentSettings?.isActive ?? null,
      };
      result.preflight.target = {
        mode: targetMode,
        marketType: targetMarketType,
        symbol: resolvedSymbol,
        chainId: resolvedChainId,
        walletId: resolvedWalletId,
        walletAddress: resolvedWalletAddress,
        masterWalletAddress: resolvedMasterWalletAddress,
        buyLimit: resolvedBuyLimit,
        protocol: resolvedProtocol ?? null,
        leverage: resolvedLeverage,
      };
      if (settlementConfigPayload) {
        result.preflight.derivedSettlementConfig = settlementConfigPayload;
      }
      if (simulationConfigPayload) {
        result.preflight.derivedSimulationConfig = simulationConfigPayload;
      }

      const mainUpdateRequested = mainFieldKeys.some((field) => hasOwnField(params, field));
      {
        const tradingDataResult: Record<string, unknown> = {};
        let billingHeaders: Record<string, string> = {};
        let billingRequirement: UpdateAgentBillingRequirement = "unknown";
        let billingError: string | null = null;

        if (mainUpdateRequested) {
          try {
            const billingBypassed = await fetchBillingBypassStatus(npub);
            billingRequirement = billingBypassed ? "bypassed" : "required";
          } catch (e: any) {
            billingError = `billing bypass check failed: ${e.message}`;
            tradingDataResult.billingBypassWarning = billingError;
            warnings.push(`Could not confirm billing bypass status before trading-data update: ${e.message}`);
          }

          if (billingRequirement !== "bypassed") {
            try {
              const billingWallet = buildBillingWallet();
              tradingDataResult.billingWalletRegistration = await ensureBillingWalletRegistered({
                npub,
                publicKey,
                privateKey,
                wallet: billingWallet,
              });
              billingHeaders = await buildBillingHeaders(billingWallet);
            } catch (e: any) {
              billingError = e.message;
              tradingDataResult.billingWarning = e.message;
              warnings.push(`Billing wallet registration failed before trading-data update: ${e.message}`);
            }
          }

          const billingDecision = decideUpdateAgentBilling({
            requirement: billingRequirement,
            billingHeaders,
            billingError,
          });
          if (!billingDecision.canProceed) {
            result.error = billingDecision.error;
            result.tradingData = {
              ...tradingDataResult,
              ok: false,
              blocked: true,
              requirement: billingDecision.requirement,
              requiresBillingHeaders: billingDecision.requiresBillingHeaders,
              hasBillingHeaders: billingDecision.hasBillingHeaders,
              error: billingDecision.error,
            };
            result.warnings = Array.from(new Set(warnings));
            debugLog("update_agent", "result", result);
            return textResult(result);
          }
        }

        const logSignature = Signer.getSignature(
          {
            agent_id: params.agentId,
            action: "update",
            user: npub,
            timestamp: signedAt,
          },
          privateKey,
          {
            agent_id: "number",
            action: "string",
            user: "string",
            timestamp: "number",
          } as const,
        );

        const body: Record<string, unknown> = {
          id: params.agentId,
          signature: logSignature,
          timestamp: signedAt,
          delegateToTradingBot: true,
          delegateToSettlement: true,
          prevMode: currentMode,
        };
        if (hasOwnField(params, "name")) body.name = params.name;
        if (hasOwnField(params, "description")) body.description = params.description;
        if (hasOwnField(params, "avatarUrl")) body.avatarUrl = params.avatarUrl;
        if (hasOwnField(params, "strategy")) body.strategy = params.strategy;
        if (hasOwnField(params, "strategyDescription")) body.strategyDescription = params.strategyDescription;
        if (hasOwnField(params, "isActive")) body.isActive = params.isActive;
        if (hasOwnField(params, "leverage")) body.leverage = params.leverage;
        if (hasOwnField(params, "strategyFeePerPeriod")) body.strategyFeePerPeriod = params.strategyFeePerPeriod;
        if (hasOwnField(params, "mode")) body.mode = targetMode;
        if (hasOwnField(params, "marketType")) body.marketType = targetMarketType;
        if (hasOwnField(params, "symbol")) body.symbol = params.symbol;
        if (hasOwnField(params, "chainId")) body.chainId = params.chainId;
        if (hasOwnField(params, "walletAddress")) body.walletAddress = resolvedWalletAddress;
        if (hasOwnField(params, "buyLimit")) body.buyLimit = params.buyLimit;
        if (hasOwnField(params, "protocol")) body.protocol = params.protocol;
        if (settlementConfigPayload) body.settlement_config = settlementConfigPayload;

        debugLog("update_agent", "trading-data.req", { url: `${baseUrl}/api/agent`, body, hasBillingHeaders: Object.keys(billingHeaders).length > 0 });
        const res = await fetch(`${baseUrl}/api/agent`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            ...billingHeaders,
          },
          body: JSON.stringify(body),
        });
        const responseBody = await parseResponseBody(res);
        const ok = res.ok && responseBody?.success !== false;
        result.tradingData = {
          ...tradingDataResult,
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
          fetch(`${baseUrl}/api/agent/${params.agentId}`).then(async (res) => await parseResponseBody(res)),
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
    description: "Initialize a trading session: check/generate Nostr keys and optionally list wallets (live mode). Replaces sequential calls to get_or_create_nostr_keys + list_wallets.",
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
                walletId: w.id,
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
    name: "setup_live_wallet",
    description: "Store an agent wallet key in TEE and register it in the backend. Replaces sequential calls to store_wallet_in_tee + register_wallet.",
    parameters: Type.Object({
      ethAgentPrivateKey: Type.String({ description: "Agent wallet private key (hex, without 0x)" }),
      masterWalletAddress: Type.String({ description: "Master wallet address (0x...)" }),
      network: Type.Optional(Type.String({ description: '"testnet" or "mainnet"', default: "testnet" })),
    }),
    async execute(
      _id: string,
      params: { ethAgentPrivateKey: string; masterWalletAddress: string; network?: string },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      debugLog("setup_live_wallet", "entry", { masterWalletAddress: params.masterWalletAddress, network: params.network ?? "testnet" });
      const result: Record<string, unknown> = {};

      // Step 1: Store in TEE
      let agentWalletAddress: string;
      try {
        const pubKeyRes = await fetch(`${walletAgentUrl}/pubkey`);
        if (!pubKeyRes.ok) throw new Error(`Failed to get wallet-agent pubkey: ${pubKeyRes.status}`);
        const { publicKey: walletAgentPubKey } = await pubKeyRes.json();

        const ephemeralKey = Keys.generatePrivateKey();
        const ephemeralPubKey = Keys.getPublicKey(ephemeralKey);
        const encrypted = await Crypto.encryptSharedMessage(
          ephemeralKey,
          walletAgentPubKey,
          params.ethAgentPrivateKey,
        );
        const encryptedPrivateKey = `${encrypted}&pbk=02${ephemeralPubKey}`;

        const signedAt = Math.floor(Date.now() / 1000);
        const body = {
          npub,
          public_key: walletAgentPubKey,
          encrypted_private_key: encryptedPrivateKey,
          signed_at: signedAt,
        };
        const signature = Signer.getSignature(body, privateKey, {
          npub: "string",
          public_key: "string",
          encrypted_private_key: "string",
          signed_at: "number",
        } as const);

        debugLog("setup_live_wallet", "api.req wallet-agent/wallets", { npub, public_key: walletAgentPubKey, signed_at: signedAt });
        const res = await fetch(`${walletAgentUrl}/wallets`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-public-key": publicKey,
            "x-signature": signature,
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (res.ok) {
          agentWalletAddress = data.eth_address ?? data.address;
          debugLog("setup_live_wallet", "api.res wallet-agent/wallets", { status: res.status, agentWalletAddress });
        } else if (data?.code === "WALLET_EXISTS") {
          const match = data.error?.match(/(0x[0-9a-fA-F]{40})/);
          if (match) {
            agentWalletAddress = match[1];
          } else {
            const listRes = await fetch(`${walletAgentUrl}/wallets/${npub}`, {
              headers: { "x-public-key": publicKey },
            });
            const listData = await listRes.json();
            const wallets = listData.wallets || [];
            agentWalletAddress = wallets[wallets.length - 1]?.eth_address;
          }
          if (!agentWalletAddress) throw new Error("No wallets found for this npub");
          debugLog("setup_live_wallet", "api.res wallet-agent/wallets", { status: res.status, agentWalletAddress, walletExists: true });
        } else {
          debugLog("setup_live_wallet", "api.res wallet-agent/wallets", { status: res.status, error: data });
          throw new Error(`TEE storage failed: ${res.status} ${JSON.stringify(data)}`);
        }

        result.teeStorage = { ok: true, agentWalletAddress };
      } catch (e: any) {
        result.teeStorage = { ok: false, error: e.message };
        debugLog("setup_live_wallet", "result", result);
        return textResult(result);
      }

      // Step 2: Register wallet in backend
      try {
        const auth = getAuthHeader(publicKey, privateKey);

        const findWallet = async () => {
          const res = await fetch(`${baseUrl}/api/wallets?npub=${npub}`, {
            headers: { Authorization: auth },
          });
          if (!res.ok) return undefined;
          const data = await res.json();
          return (data.data || []).find(
            (w: any) => w.wallet_address.toLowerCase() === agentWalletAddress.toLowerCase(),
          );
        };

        const existing = await findWallet();
        if (existing) {
          result.registration = { ok: true, walletId: existing.id, walletAddress: existing.wallet_address };
          debugLog("setup_live_wallet", "result", result);
          return textResult(result);
        }

        const createdAt = Math.floor(Date.now() / 1000);
        const walletSig = Signer.getSignature(
          {
            created_at: createdAt,
            wallet_address: agentWalletAddress,
            action: "connected",
            npub,
          },
          privateKey,
          {
            created_at: "number",
            wallet_address: "string",
            action: "string",
            npub: "string",
          } as const,
        );

        const registerBody = {
          npub,
          name: `Wallet-${createdAt}`,
          walletAddress: agentWalletAddress,
          signature: walletSig,
          createdAt,
          walletType: "hyperliquid_agent",
          masterWalletAddress: params.masterWalletAddress,
          hyperliquidNetwork: params.network ?? "testnet",
        };
        debugLog("setup_live_wallet", "api.req POST /api/wallets", registerBody);
        const res = await fetch(`${baseUrl}/api/wallets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(registerBody),
        });
        const resBody = await res.json().catch(() => null);
        debugLog("setup_live_wallet", "api.res POST /api/wallets", { status: res.status, body: resBody });
        if (!res.ok) {
          const retry = await findWallet();
          if (retry) {
            result.registration = { ok: true, walletId: retry.id, walletAddress: retry.wallet_address };
            debugLog("setup_live_wallet", "result", result);
            return textResult(result);
          }
          throw new Error(`register_wallet failed: ${res.status}`);
        }

        const created = await findWallet();
        if (!created) throw new Error("Wallet not found after registration");
        result.registration = { ok: true, walletId: created.id, walletAddress: created.wallet_address };
      } catch (e: any) {
        result.registration = { ok: false, error: e.message };
      }

      debugLog("setup_live_wallet", "result", result);
      return textResult(result);
    },
  });

  api.registerTool({
    name: "prepare_agent_creation",
    description: "Preflight for direct agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer, ensures the billing wallet is registered via /api/auth/login, determines whether upfront billing setup is required, loads active /api/nft-config eligibility, calculates OSWAP and vault credit requirements when needed, estimates BNB and gas needs, and returns the full execution plan before any on-chain transaction.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"', default: "spot" })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        mode?: string;
        marketType?: string;
        symbol?: string;
      },
    ) {
      const { privateKey, npub, publicKey } = loadKeys(pluginConfig);
      debugLog("prepare_agent_creation", "entry", {
        name: params.name,
        mode: params.mode ?? "paper",
        marketType: params.marketType ?? "spot",
        symbol: params.symbol,
        usesNostrPrivateKey: true,
      });
      try {
        const prepared = await prepareAgentCreationContext({
          name: params.name,
          mode: params.mode,
          marketType: params.marketType,
          symbol: params.symbol,
          npub,
          publicKey,
          privateKey,
        });
        return textResult(prepared.prepared);
      } catch (e: any) {
        return textResult({ error: e.message });
      }
    },
  });

  api.registerTool({
    name: "prepare_copy_agent",
    description: "Validate prerequisites and infer defaults for creating a live copy-trading agent from an existing source agent. Mirrors the normal live-agent creation preflight, including any required billing setup before calling /api/copy-agent.",
    parameters: Type.Object({
      sourceAgentId: Type.Number({ description: "Existing source agent ID to copy" }),
      alias: Type.Optional(Type.String({ description: "Optional display name for the copied agent" })),
      walletId: Type.Optional(Type.Number({ description: "Optional wallet ID to preview against the source agent chain" })),
      walletAddress: Type.Optional(Type.String({ description: "Optional wallet address override used together with walletId preview" })),
    }),
    async execute(
      _id: string,
      params: {
        sourceAgentId: number;
        alias?: string;
        walletId?: number;
        walletAddress?: string;
      },
    ) {
      const { privateKey, npub, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const alias = typeof params.alias === "string" && params.alias.trim() ? params.alias.trim() : undefined;

      const result: Record<string, unknown> = {
        copy: {
          sourceAgentId: params.sourceAgentId,
          alias: alias ?? null,
          liveOnly: true,
        },
      };

      let sourceAgent: any;
      try {
        sourceAgent = await fetchPublicAgentProfile(params.sourceAgentId);
      } catch (e: any) {
        return textResult({ ...result, error: e.message });
      }

      const sourceName = typeof sourceAgent?.name === "string" && sourceAgent.name.trim()
        ? sourceAgent.name.trim()
        : `Agent ${params.sourceAgentId}`;
      const sourceSymbol = typeof sourceAgent?.pair === "string" && sourceAgent.pair.trim()
        ? sourceAgent.pair.trim()
        : typeof sourceAgent?.symbol === "string" && sourceAgent.symbol.trim()
          ? sourceAgent.symbol.trim()
          : undefined;
      const sourceMarketType: "spot" | "perp" = sourceAgent?.marketType === "perp" ? "perp" : "spot";
      const sourceChainIdValue = sourceAgent?.chain_id ?? sourceAgent?.chainId;
      const sourceChainId = sourceChainIdValue == null || Number.isNaN(Number(sourceChainIdValue))
        ? null
        : Number(sourceChainIdValue);
      const sourceBuyLimitValue = sourceAgent?.buy_limit ?? sourceAgent?.buyLimit ?? null;
      const sourceBuyLimit = sourceBuyLimitValue == null || Number.isNaN(Number(sourceBuyLimitValue))
        ? null
        : Number(sourceBuyLimitValue);

      result.sourceAgent = {
        id: params.sourceAgentId,
        name: sourceName,
        owner: sourceAgent?.owner ?? null,
        mode: sourceAgent?.mode ?? null,
        pair: sourceSymbol ?? null,
        marketType: sourceMarketType,
        chainId: sourceChainId,
        currentValueUsd: sourceAgent?.current_value_usd ?? null,
        initialCapital: sourceAgent?.initialCapital ?? sourceAgent?.initial_capital ?? null,
        copiedFrom: sourceAgent?.copied_from ?? null,
      };

      if (!sourceSymbol) {
        return textResult({
          ...result,
          error: `Source agent ${params.sourceAgentId} is missing a trading pair; cannot prepare copy deployment`,
        });
      }

      let preparedContext: PreparedAgentCreationContext;
      try {
        preparedContext = await prepareAgentCreationContext({
          name: alias ?? sourceName,
          mode: "live",
          marketType: sourceMarketType,
          symbol: sourceSymbol,
          agentId: params.sourceAgentId,
          npub,
          publicKey,
          privateKey,
        });
      } catch (e: any) {
        return textResult({
          ...result,
          error: `Could not prepare copy-trade billing preflight: ${e.message}`,
        });
      }

      let inferredProtocol: string | undefined;
      let walletPreview: Record<string, unknown> | undefined;
      let walletWarning: string | undefined;
      let resolvedPreviewChainId = sourceChainId;
      let walletDerivedBuyLimit: { initialCapital: number; leverage: number; buyLimit: number } | null = null;
      if (sourceChainId != null) {
        try {
          inferredProtocol = await fetchSettlementProtocolName(sourceMarketType, sourceChainId);
        } catch (e: any) {
          walletWarning = `Could not infer settlement protocol from instruments: ${e.message}`;
        }
      }

      if (params.walletId != null || params.walletAddress) {
        try {
          const wallets = await fetchWalletsForUpdate(auth);
          const walletRecord = resolveWalletRecord(wallets, {
            walletId: params.walletId ?? null,
            walletAddress: params.walletAddress ?? null,
          });
          if (!walletRecord) {
            return textResult({
              ...result,
              error: `Wallet preview failed: no wallet matched walletId=${params.walletId ?? "null"} walletAddress=${params.walletAddress ?? "null"}`,
            });
          }

          const resolvedWalletAddress = typeof walletRecord.wallet_address === "string"
            ? walletRecord.wallet_address
            : params.walletAddress;
          const resolvedMasterWalletAddress = typeof walletRecord.master_wallet_address === "string" && walletRecord.master_wallet_address.trim()
            ? walletRecord.master_wallet_address
            : resolvedWalletAddress;

          if (resolvedPreviewChainId == null) {
            if (walletRecord.hyperliquid_network === "mainnet") {
              resolvedPreviewChainId = 999;
            } else if (walletRecord.hyperliquid_network === "testnet") {
              resolvedPreviewChainId = 998;
            }
          }

          if (resolvedPreviewChainId != null && Array.isArray(walletRecord.authorized_agents)) {
            const conflictingAgent = walletRecord.authorized_agents.find((agent: any) => Number(agent?.chainId) === resolvedPreviewChainId);
            if (conflictingAgent) {
              return textResult({
                ...result,
                error: `Wallet preview failed: wallet ${resolvedWalletAddress ?? walletRecord.id} is already authorized for agent ${conflictingAgent.id} on chain ${resolvedPreviewChainId}`,
              });
            }
          }

          walletPreview = {
            walletId: Number(walletRecord.id),
            walletAddress: resolvedWalletAddress ?? null,
            masterWalletAddress: resolvedMasterWalletAddress ?? null,
            walletType: walletRecord.wallet_type ?? null,
            network: walletRecord.hyperliquid_network ?? null,
          };

          if (!inferredProtocol) {
            inferredProtocol = inferLiveProtocol({
              marketType: sourceMarketType,
              chainId: resolvedPreviewChainId ?? undefined,
              walletNetwork: walletRecord.hyperliquid_network ?? null,
            });
          }

          if (resolvedMasterWalletAddress && resolvedPreviewChainId != null) {
            try {
              walletDerivedBuyLimit = await deriveDefaultLiveBuyLimit(
                resolvedMasterWalletAddress,
                resolvedPreviewChainId,
              );
            } catch (e: any) {
              return textResult({
                ...result,
                error: `Wallet preview failed: ${e.message}`,
              });
            }
          }
        } catch (e: any) {
          return textResult({
            ...result,
            error: `Wallet preview failed: ${e.message}`,
          });
        }
      }

      if (walletPreview) {
        result.wallet = walletPreview;
      }
      if (walletWarning) {
        result.warning = walletWarning;
      }

      result.billing = preparedContext.prepared.billing;
      result.billingWallet = preparedContext.prepared.wallet;
      result.nft = preparedContext.prepared.nft;
      result.fees = preparedContext.prepared.fees;
      if (preparedContext.prepared.gas) {
        result.gas = preparedContext.prepared.gas;
      }

      result.defaults = {
        alias: alias ?? sourceName,
        symbol: sourceSymbol,
        marketType: sourceMarketType,
        chainId: resolvedPreviewChainId,
        leverage: walletDerivedBuyLimit?.leverage ?? DEFAULT_LIVE_LEVERAGE,
        initialCapital: walletDerivedBuyLimit?.initialCapital ?? null,
        buyLimit: walletDerivedBuyLimit?.buyLimit ?? (walletPreview ? sourceBuyLimit : null),
        buyLimitSource: walletDerivedBuyLimit
          ? "selected_wallet_balance_x_leverage"
          : walletPreview
            ? "source_agent"
            : "selected_wallet_balance_x_leverage_on_confirm",
        protocol: inferredProtocol ?? null,
      };
      result.chainContext = {
        requiresUserSelection: resolvedPreviewChainId == null,
        reason: sourceAgent?.mode === "paper" ? "source_agent_is_paper" : "source_agent_missing_chain_id",
        suggestedNetworks: ["testnet", "mainnet"],
      };
      result.executionPlan = {
        billingActions: preparedContext.prepared.executionPlan.actions,
        approvals: preparedContext.prepared.executionPlan.approvals,
        depositToVault: preparedContext.prepared.executionPlan.depositToVault,
        actions: [
          "Create the copied live agent via POST /api/copy-agent (with delegateToSettlement for automatic trading-bot and settlement syncing).",
          "Authorize the selected wallet via POST /api/wallets/authorize.",
        ],
      };

      return textResult(result);
    },
  });

  api.registerTool({
    name: "deploy_agent",
    description: "Create a trading agent, performing the full billing preflight and any required active NFT/vault setup before agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer and ensures the billing wallet is registered via /api/auth/login before billing checks. Uses delegateToTradingBot and delegateToSettlement flags on POST /api/agent so the server handles all downstream syncing internally.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      initialCapital: Type.Optional(Type.Number({ description: "Initial capital amount (auto-fetched for live mode)" })),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"', default: "spot" })),
      strategy: Strategy,
      strategyDescription: Type.Optional(Type.String({ description: "Human-readable strategy summary" })),
      assetType: Type.Optional(Type.String({ description: '"crypto" or "stocks". Asset type for paper-mode simulation (used when delegateToTradingBot is true).' })),
      walletAddress: Type.Optional(Type.String({ description: "Agent wallet address (live mode)" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Master wallet address (live mode, for settlement)" })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
      chainId: Type.Optional(Type.Number({ description: "Network chain ID for both paper and live modes (e.g. Hyperliquid: 998/999, EVM: 1/56)." })),
      leverage: Type.Optional(Type.Number({ description: "Leverage multiplier" })),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        initialCapital?: number;
        mode?: string;
        marketType?: string;
        strategy: Record<string, unknown>;
        strategyDescription?: string;
        assetType?: string;
        walletAddress?: string;
        masterWalletAddress?: string;
        symbol?: string;
        chainId?: number;
        leverage?: number;
      },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const mode = params.mode ?? "paper";
      const isLive = mode === "live";
      let marketType: "spot" | "perp" = "spot";
      try {
        marketType = resolveMarketType(mode, params.marketType);
        if (isLive) {
          if (!params.walletAddress) {
            return textResult({ error: "walletAddress is required for live mode" });
          }
          if (!params.masterWalletAddress) {
            return textResult({ error: "masterWalletAddress is required for live mode" });
          }
        }
      } catch (e: any) {
        return textResult({ error: e.message });
      }
      debugLog("deploy_agent", "entry", { ...params, usesNostrPrivateKey: true });
      const result: Record<string, unknown> = {};
      let preparedContext: PreparedAgentCreationContext;
      let billingHeaders: EthHeaders | undefined;
      let billingWallet: Wallet | undefined;
      let billingTransactions: Record<string, any> | undefined;

      // Auto-fetch initial capital for live mode
      let initialCapital = params.initialCapital;
      if (isLive && initialCapital == null && params.masterWalletAddress) {
        try {
          const derived = await deriveDefaultLiveBuyLimit(
            params.masterWalletAddress,
            params.chainId ?? 998,
          );
          if (derived) {
            initialCapital = derived.initialCapital;
            debugLog("deploy_agent", "auto-fetched balance", { initialCapital, chainId: params.chainId });
          }
        } catch (e: any) {
          return textResult({ error: e.message });
        }
      }
      if (initialCapital == null) {
        return textResult({ error: "initialCapital is required" });
      }

      // Default leverage to 3x for live mode
      const leverage = isLive ? (params.leverage ?? DEFAULT_LIVE_LEVERAGE) : params.leverage;

      // Auto-compute buyLimit and settlement_config for live
      const buyLimit = isLive && leverage ? initialCapital * leverage : undefined;
      const settlementConfig = isLive && params.masterWalletAddress && params.walletAddress
        ? { eth_address: params.masterWalletAddress, agent_address: params.walletAddress }
        : undefined;
      debugLog("deploy_agent", "computed", { buyLimit, settlementConfig });

      try {
        preparedContext = await prepareAgentCreationContext({
          name: params.name,
          mode,
          marketType,
          symbol: params.symbol,
          npub,
          publicKey,
          privateKey,
        });
      } catch (e: any) {
        return textResult({ error: e.message });
      }

      const billingRequired = preparedContext.prepared.billing.required;
      if (!billingRequired) {
        result.billing = {
          required: false,
          bypassed: true,
          reason: "billing_not_required",
        };
      } else {
        const activeBillingWallet = preparedContext.billingWallet;
        if (!activeBillingWallet) {
          return textResult({ error: "Billing wallet could not be derived from nostrPrivateKey" });
        }
        billingWallet = activeBillingWallet;
        billingTransactions = {
          swap: { ok: preparedContext.oswapShortfallRaw === 0n, skipped: preparedContext.oswapShortfallRaw === 0n },
          nftApproval: { ok: !preparedContext.nftApprovalRequired, skipped: !preparedContext.nftApprovalRequired },
          nftMint: { ok: preparedContext.oswapForNftRaw === 0n, skipped: preparedContext.oswapForNftRaw === 0n },
          vaultApproval: { ok: !preparedContext.vaultApprovalRequired, skipped: !preparedContext.vaultApprovalRequired },
          vaultDeposit: { ok: preparedContext.oswapForInitialVaultCreditRaw === 0n, skipped: preparedContext.oswapForInitialVaultCreditRaw === 0n },
        };
        result.billing = {
          required: true,
          walletAddress: activeBillingWallet.address,
          preflight: preparedContext.prepared,
          transactions: billingTransactions,
        };

        if (preparedContext.bnbShortfallRaw > 0n) {
          return textResult({
            error: `Insufficient BNB on ${billingEvmConfig.networkLabel}. Shortfall: ${formatAmount(preparedContext.bnbShortfallRaw, 18, 8)} BNB. Fund the billing wallet on ${billingEvmConfig.networkLabel}, not another chain.`,
            ...result,
          });
        }

        const swapPath = [billingEvmConfig.wethAddress, billingEvmConfig.tokenAddress];
        const routerContract = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, activeBillingWallet) as any;
        const tokenContract = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, activeBillingWallet) as any;
        if (!preparedContext.selectedEligibleNft) {
          return textResult({ error: "No active eligible NFT config available", ...result });
        }
        const nftContract = new Contract(preparedContext.selectedEligibleNft.contractAddress, NFT_ABI, activeBillingWallet) as any;
        const vaultContract = new Contract(billingEvmConfig.vaultAddress, VAULT_ABI, activeBillingWallet) as any;

        const failBilling = (step: string, error: string) => {
          if (billingTransactions) {
            billingTransactions[step] = { ok: false, skipped: false, error };
          }
          return textResult({
            error,
            ...result,
          });
        };

        if (preparedContext.oswapShortfallRaw > 0n) {
          try {
            const deadline = Math.floor(Date.now() / 1000) + 1_200;
            const swapTx = await routerContract.swapETHForExactTokens(
              preparedContext.oswapShortfallRaw,
              swapPath,
              activeBillingWallet.address,
              deadline,
              { value: preparedContext.bnbForSwapMaxRaw },
            );
            const receipt = await swapTx.wait();
            billingTransactions!.swap = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              oswapAmount: formatAmount(preparedContext.oswapShortfallRaw, billingEvmConfig.tokenDecimals),
              maxBnbAmount: formatAmount(preparedContext.bnbForSwapMaxRaw, 18, 8),
            };
          } catch (e: any) {
            return failBilling("swap", `BNB to ${billingEvmConfig.tokenSymbol} swap failed: ${e.message}`);
          }
        }

        if (preparedContext.nftApprovalRequired) {
          try {
            const approveTx = await tokenContract.approve(
              preparedContext.selectedEligibleNft.contractAddress,
              preparedContext.oswapForNftRaw,
            );
            const receipt = await approveTx.wait();
            billingTransactions!.nftApproval = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForNftRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("nftApproval", `NFT approval failed: ${e.message}`);
          }
        }

        if (preparedContext.oswapForNftRaw > 0n) {
          try {
            const mintTx = await nftContract.stake(preparedContext.oswapForNftRaw);
            const receipt = await mintTx.wait();
            billingTransactions!.nftMint = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForNftRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("nftMint", `NFT mint failed: ${e.message}`);
          }
        }

        if (preparedContext.vaultApprovalRequired) {
          try {
            const approveTx = await tokenContract.approve(
              billingEvmConfig.vaultAddress,
              preparedContext.oswapForInitialVaultCreditRaw,
            );
            const receipt = await approveTx.wait();
            billingTransactions!.vaultApproval = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("vaultApproval", `Vault approval failed: ${e.message}`);
          }
        }

        if (preparedContext.oswapForInitialVaultCreditRaw > 0n) {
          try {
            const depositTx = await vaultContract.deposit(
              activeBillingWallet.address,
              preparedContext.oswapForInitialVaultCreditRaw,
            );
            const receipt = await depositTx.wait();
            const indexedBalance = await waitForVaultCredit(
              activeBillingWallet,
              preparedContext.existingVaultCreditRaw + preparedContext.oswapForInitialVaultCreditRaw,
            );
            billingTransactions!.vaultDeposit = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
              indexedAvailableBalance: formatAmount(indexedBalance.availableBalanceRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("vaultDeposit", `Vault deposit failed: ${e.message}`);
          }
        }

        billingHeaders = await buildBillingHeaders(activeBillingWallet);
      }

      // Step 1: Create agent (fatal if fails)
      let agentId: number;
      let agentUrl: string;
      const creationTimestamp = new Date().toISOString();
      try {
        const payload: Record<string, unknown> = {
          name: params.name,
          initialCapital,
          mode,
          marketType,
          owner: npub,
        };
        if (leverage != null) payload.leverage = leverage;
        if (buyLimit != null) payload.buyLimit = buyLimit;
        if (params.chainId != null) payload.chainId = params.chainId;
        if (params.assetType) payload.assetType = params.assetType;
        if (params.strategy) payload.strategy = params.strategy;
        if (params.strategyDescription) payload.strategyDescription = params.strategyDescription;
        if (params.walletAddress) payload.walletAddress = params.walletAddress;
        if (params.symbol) payload.symbol = params.symbol;
        if (settlementConfig) payload.settlement_config = settlementConfig;
        payload.delegateToTradingBot = true;
        if (isLive) payload.delegateToSettlement = true;

        debugLog("deploy_agent", "create.api.req POST /api/agent", payload);
        const res = await fetch(`${baseUrl}/api/agent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            ...(billingHeaders ?? {}),
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
        agentUrl = `https://agent.openswap.xyz/trading-agents/${publicKey}/${agentId}`;
        debugLog("deploy_agent", "create.api.res", { status: res.status, body: data });
        result.create = { ok: true, agentId, agentUrl, createdAt: creationTimestamp };
      } catch (e: any) {
        result.create = { ok: false, error: e.message };
        return textResult(result);
      }

      // Step 2: Log action
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const sigData = {
          agent_id: agentId,
          action: "create",
          user: Nip19.npubEncode(publicKey),
          timestamp,
        };
        const signature = Signer.getSignature(sigData, privateKey, {
          agent_id: "number",
          action: "string",
          user: "string",
          timestamp: "number",
        } as const);

        const logBody = { agentId, action: "create", signature, timestamp };
        debugLog("deploy_agent", "log.api.req POST /agent-action-log", logBody);
        const res = await fetch(`${baseUrl}/api/agent-action-log`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
          },
          body: JSON.stringify(logBody),
        });
        const logResBody = await res.json().catch(() => null);
        debugLog("deploy_agent", "log.api.res", { status: res.status, body: logResBody });
        result.log = { ok: res.ok };
      } catch {
        result.log = { ok: false };
      }

      // Step 3: Verify
      try {
        const res = await fetch(`${baseUrl}/api/agent/${agentId}`);
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

      if (billingRequired && billingWallet) {
        try {
          const [postBalance, subscriptions] = await Promise.all([
            fetchBillingBalanceSnapshot(billingWallet),
            fetchBillingSubscriptions(billingWallet),
          ]);
          const matchedSubscription = subscriptions.find((subscription: any) => Number(subscription.agent_id) === agentId);
          (result.billing as any).result = {
            nftStatus: preparedContext.hasEligibleNft ? "existing_nft_verified" : "nft_minted",
            vaultDepositAmount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            updatedVaultCredit: formatAmount(postBalance.availableBalanceRaw, billingEvmConfig.tokenDecimals),
            pendingWithdrawalCredit: formatAmount(postBalance.pendingWithdrawalBalanceRaw, billingEvmConfig.tokenDecimals),
            feeBreakdown: preparedContext.prepared.fees,
            agentId,
            agentName: params.name,
            creationTimestamp,
            nextBillingDateEstimate: matchedSubscription?.next_renewal_at
              ?? new Date(Date.now() + preparedContext.billingPeriodSeconds * 1_000).toISOString(),
          };
        } catch (e: any) {
          (result.billing as any).result = {
            nftStatus: preparedContext.hasEligibleNft ? "existing_nft_verified" : "nft_minted",
            vaultDepositAmount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            feeBreakdown: preparedContext.prepared.fees,
            agentId,
            agentName: params.name,
            creationTimestamp,
            nextBillingDateEstimate: new Date(Date.now() + preparedContext.billingPeriodSeconds * 1_000).toISOString(),
            warning: e.message,
          };
        }
      }

      debugLog("deploy_agent", "result", result);
      return textResult(result);
    },
  });

  api.registerTool({
    name: "deploy_copy_agent",
    description: "Create a live copy-trading agent from an existing source agent. Executes the flow: copy-agent (with delegateToSettlement for server-side trading-bot and settlement syncing), wallet authorization, and verification.",
    parameters: Type.Object({
      sourceAgentId: Type.Number({ description: "Existing source agent ID to copy" }),
      alias: Type.Optional(Type.String({ description: "Optional display name for the copied agent. Defaults to the source agent name." })),
      walletId: Type.Number({ description: "Wallet ID to assign to the copied live agent" }),
      walletAddress: Type.Optional(Type.String({ description: "Optional wallet address override. Usually resolved from walletId." })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Optional settlement master wallet address override. Defaults to wallet.master_wallet_address or walletAddress." })),
      buyLimit: Type.Optional(Type.Number({ description: "Optional max buy amount in USD per copied trade. Defaults to selected wallet USDC balance multiplied by the default live leverage." })),
      order: Type.Optional(CopyTradeOrderConfig),
      protocol: Type.Optional(Type.String({ description: "Optional settlement protocol override. If omitted, inferred from settlement instruments or the wallet network." })),
    }),
    async execute(
      _id: string,
      params: {
        sourceAgentId: number;
        alias?: string;
        walletId: number;
        walletAddress?: string;
        masterWalletAddress?: string;
        buyLimit?: number;
        order?: {
          type: string;
          size: {
            mode: string;
            value?: number;
          };
        };
        protocol?: string;
      },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const alias = typeof params.alias === "string" && params.alias.trim() ? params.alias.trim() : undefined;
      debugLog("deploy_copy_agent", "entry", {
        ...params,
        alias: alias ?? null,
        usesNostrPrivateKey: true,
      });

      const result: Record<string, unknown> = {
        copy: {
          sourceAgentId: params.sourceAgentId,
          alias: alias ?? null,
          liveOnly: true,
        },
        warnings: [] as string[],
      };
      const warnings = result.warnings as string[];
      let preparedContext: PreparedAgentCreationContext;
      let billingHeaders: EthHeaders | undefined;
      let billingWallet: Wallet | undefined;
      let billingTransactions: Record<string, any> | undefined;

      let sourceAgent: any;
      try {
        sourceAgent = await fetchPublicAgentProfile(params.sourceAgentId);
      } catch (e: any) {
        result.error = e.message;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const sourceName = typeof sourceAgent?.name === "string" && sourceAgent.name.trim()
        ? sourceAgent.name.trim()
        : `Agent ${params.sourceAgentId}`;
      const sourceSymbol = typeof sourceAgent?.pair === "string" && sourceAgent.pair.trim()
        ? sourceAgent.pair.trim()
        : typeof sourceAgent?.symbol === "string" && sourceAgent.symbol.trim()
          ? sourceAgent.symbol.trim()
          : undefined;
      if (!sourceSymbol) {
        result.error = `Source agent ${params.sourceAgentId} is missing a trading pair; cannot deploy copy agent`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const sourceMarketType: "spot" | "perp" = sourceAgent?.marketType === "perp" ? "perp" : "spot";
      const sourceChainIdValue = sourceAgent?.chain_id ?? sourceAgent?.chainId;
      const sourceChainId = sourceChainIdValue == null || Number.isNaN(Number(sourceChainIdValue))
        ? null
        : Number(sourceChainIdValue);
      result.sourceAgent = {
        id: params.sourceAgentId,
        name: sourceName,
        owner: sourceAgent?.owner ?? null,
        pair: sourceSymbol,
        marketType: sourceMarketType,
        chainId: sourceChainId,
        buyLimit: sourceAgent?.buy_limit ?? sourceAgent?.buyLimit ?? null,
        currentValueUsd: sourceAgent?.current_value_usd ?? null,
        copiedFrom: sourceAgent?.copied_from ?? null,
      };

      try {
        preparedContext = await prepareAgentCreationContext({
          name: alias ?? sourceName,
          mode: "live",
          marketType: sourceMarketType,
          symbol: sourceSymbol,
          agentId: params.sourceAgentId,
          npub,
          publicKey,
          privateKey,
        });
      } catch (e: any) {
        result.error = `Could not prepare copy-trade billing preflight: ${e.message}`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      let wallets: any[];
      try {
        wallets = await fetchWalletsForUpdate(auth);
      } catch (e: any) {
        result.error = `Failed to load wallets before copy deployment: ${e.message}`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const walletRecord = resolveWalletRecord(wallets, {
        walletId: params.walletId,
        walletAddress: params.walletAddress ?? null,
      });
      if (!walletRecord) {
        result.error = `No wallet matched walletId=${params.walletId}${params.walletAddress ? ` walletAddress=${params.walletAddress}` : ""}`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const resolvedWalletId = Number(walletRecord.id);
      const resolvedWalletAddress = typeof params.walletAddress === "string" && params.walletAddress.trim()
        ? params.walletAddress.trim()
        : typeof walletRecord.wallet_address === "string" && walletRecord.wallet_address.trim()
          ? walletRecord.wallet_address.trim()
          : undefined;
      if (!resolvedWalletAddress) {
        result.error = `Wallet ${resolvedWalletId} is missing wallet_address`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const resolvedMasterWalletAddress = typeof params.masterWalletAddress === "string" && params.masterWalletAddress.trim()
        ? params.masterWalletAddress.trim()
        : typeof walletRecord.master_wallet_address === "string" && walletRecord.master_wallet_address.trim()
          ? walletRecord.master_wallet_address.trim()
          : resolvedWalletAddress;
      const walletNetwork = typeof walletRecord.hyperliquid_network === "string" && walletRecord.hyperliquid_network.trim()
        ? walletRecord.hyperliquid_network.trim()
        : null;

      let resolvedChainId = sourceChainId;
      if (resolvedChainId == null) {
        if (walletNetwork === "mainnet") {
          resolvedChainId = 999;
        } else if (walletNetwork === "testnet") {
          resolvedChainId = 998;
        }
      }
      if (resolvedChainId == null) {
        result.error = `Source agent ${params.sourceAgentId} is missing chainId; cannot register settlement trader`;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      if (Array.isArray(walletRecord.authorized_agents)) {
        const conflictingAgent = walletRecord.authorized_agents.find((agent: any) => Number(agent?.chainId) === resolvedChainId);
        if (conflictingAgent) {
          result.error = `Wallet ${resolvedWalletAddress} is already authorized for agent ${conflictingAgent.id} on chain ${resolvedChainId}`;
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }
      }

      let resolvedProtocol = typeof params.protocol === "string" && params.protocol.trim()
        ? params.protocol.trim()
        : undefined;
      if (!resolvedProtocol) {
        try {
          resolvedProtocol = await fetchSettlementProtocolName(sourceMarketType, resolvedChainId);
        } catch (e: any) {
          warnings.push(`Could not infer settlement protocol from instruments: ${e.message}`);
        }
      }
      if (!resolvedProtocol) {
        resolvedProtocol = inferLiveProtocol({
          marketType: sourceMarketType,
          chainId: resolvedChainId,
          walletNetwork,
        }) ?? (sourceMarketType === "perp" ? "hyperliquid" : undefined);
      }

      let derivedDefaultBuyLimit: { initialCapital: number; leverage: number; buyLimit: number } | null = null;
      try {
        derivedDefaultBuyLimit = await deriveDefaultLiveBuyLimit(
          resolvedMasterWalletAddress,
          resolvedChainId,
        );
      } catch (e: any) {
        result.error = e.message;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      const resolvedBuyLimit = hasOwnField(params, "buyLimit")
        ? Number(params.buyLimit)
        : (derivedDefaultBuyLimit?.buyLimit ?? 0);
      if (!Number.isFinite(resolvedBuyLimit) || resolvedBuyLimit < 0) {
        result.error = "buyLimit must be a finite number greater than or equal to 0";
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }
      if (resolvedBuyLimit === 0) {
        warnings.push("buyLimit resolved to 0 USD. The copied agent may not place meaningful live trades until this is updated.");
      }

      const settlementConfigPayload: Record<string, unknown> = {
        eth_address: resolvedMasterWalletAddress,
        symbol: sourceSymbol,
        chain_id: resolvedChainId,
        buy_limit_usd: resolvedBuyLimit,
      };
      if (normalizeAddress(resolvedMasterWalletAddress) !== normalizeAddress(resolvedWalletAddress)) {
        settlementConfigPayload.agent_address = resolvedWalletAddress;
      }
      if (resolvedProtocol) {
        settlementConfigPayload.protocol = resolvedProtocol;
      }
      const settlementConfig = JSON.stringify(settlementConfigPayload);

      result.wallet = {
        walletId: resolvedWalletId,
        walletAddress: resolvedWalletAddress,
        masterWalletAddress: resolvedMasterWalletAddress,
        walletType: walletRecord.wallet_type ?? null,
        network: walletNetwork,
      };
      result.defaults = {
        symbol: sourceSymbol,
        marketType: sourceMarketType,
        chainId: resolvedChainId,
        leverage: derivedDefaultBuyLimit?.leverage ?? DEFAULT_LIVE_LEVERAGE,
        initialCapital: derivedDefaultBuyLimit?.initialCapital ?? null,
        buyLimit: resolvedBuyLimit,
        buyLimitSource: hasOwnField(params, "buyLimit")
          ? "user_override"
          : "selected_wallet_balance_x_leverage",
        protocol: resolvedProtocol ?? null,
      };

      const billingRequired = preparedContext.prepared.billing.required;
      if (!billingRequired) {
        result.billing = {
          required: false,
          bypassed: true,
          reason: "billing_not_required",
        };
      } else {
        const activeBillingWallet = preparedContext.billingWallet;
        if (!activeBillingWallet) {
          result.error = "Billing wallet could not be derived from nostrPrivateKey";
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }
        billingWallet = activeBillingWallet;
        billingTransactions = {
          swap: { ok: preparedContext.oswapShortfallRaw === 0n, skipped: preparedContext.oswapShortfallRaw === 0n },
          nftApproval: { ok: !preparedContext.nftApprovalRequired, skipped: !preparedContext.nftApprovalRequired },
          nftMint: { ok: preparedContext.oswapForNftRaw === 0n, skipped: preparedContext.oswapForNftRaw === 0n },
          vaultApproval: { ok: !preparedContext.vaultApprovalRequired, skipped: !preparedContext.vaultApprovalRequired },
          vaultDeposit: { ok: preparedContext.oswapForInitialVaultCreditRaw === 0n, skipped: preparedContext.oswapForInitialVaultCreditRaw === 0n },
        };
        result.billing = {
          required: true,
          walletAddress: activeBillingWallet.address,
          preflight: preparedContext.prepared,
          transactions: billingTransactions,
        };

        if (preparedContext.bnbShortfallRaw > 0n) {
          result.error = `Insufficient BNB on ${billingEvmConfig.networkLabel}. Shortfall: ${formatAmount(preparedContext.bnbShortfallRaw, 18, 8)} BNB. Fund the billing wallet on ${billingEvmConfig.networkLabel}, not another chain.`;
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }

        const swapPath = [billingEvmConfig.wethAddress, billingEvmConfig.tokenAddress];
        const routerContract = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, activeBillingWallet) as any;
        const tokenContract = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, activeBillingWallet) as any;
        if (!preparedContext.selectedEligibleNft) {
          result.error = "No active eligible NFT config available";
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }
        const nftContract = new Contract(preparedContext.selectedEligibleNft.contractAddress, NFT_ABI, activeBillingWallet) as any;
        const vaultContract = new Contract(billingEvmConfig.vaultAddress, VAULT_ABI, activeBillingWallet) as any;

        const failBilling = (step: string, error: string) => {
          if (billingTransactions) {
            billingTransactions[step] = { ok: false, skipped: false, error };
          }
          result.error = error;
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        };

        if (preparedContext.oswapShortfallRaw > 0n) {
          try {
            const deadline = Math.floor(Date.now() / 1000) + 1_200;
            const swapTx = await routerContract.swapETHForExactTokens(
              preparedContext.oswapShortfallRaw,
              swapPath,
              activeBillingWallet.address,
              deadline,
              { value: preparedContext.bnbForSwapMaxRaw },
            );
            const receipt = await swapTx.wait();
            billingTransactions!.swap = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              oswapAmount: formatAmount(preparedContext.oswapShortfallRaw, billingEvmConfig.tokenDecimals),
              maxBnbAmount: formatAmount(preparedContext.bnbForSwapMaxRaw, 18, 8),
            };
          } catch (e: any) {
            return failBilling("swap", `BNB to ${billingEvmConfig.tokenSymbol} swap failed: ${e.message}`);
          }
        }

        if (preparedContext.nftApprovalRequired) {
          try {
            const approveTx = await tokenContract.approve(
              preparedContext.selectedEligibleNft.contractAddress,
              preparedContext.oswapForNftRaw,
            );
            const receipt = await approveTx.wait();
            billingTransactions!.nftApproval = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForNftRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("nftApproval", `NFT approval failed: ${e.message}`);
          }
        }

        if (preparedContext.oswapForNftRaw > 0n) {
          try {
            const mintTx = await nftContract.stake(preparedContext.oswapForNftRaw);
            const receipt = await mintTx.wait();
            billingTransactions!.nftMint = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForNftRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("nftMint", `NFT mint failed: ${e.message}`);
          }
        }

        if (preparedContext.vaultApprovalRequired) {
          try {
            const approveTx = await tokenContract.approve(
              billingEvmConfig.vaultAddress,
              preparedContext.oswapForInitialVaultCreditRaw,
            );
            const receipt = await approveTx.wait();
            billingTransactions!.vaultApproval = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("vaultApproval", `Vault approval failed: ${e.message}`);
          }
        }

        if (preparedContext.oswapForInitialVaultCreditRaw > 0n) {
          try {
            const depositTx = await vaultContract.deposit(
              activeBillingWallet.address,
              preparedContext.oswapForInitialVaultCreditRaw,
            );
            const receipt = await depositTx.wait();
            const indexedBalance = await waitForVaultCredit(
              activeBillingWallet,
              preparedContext.existingVaultCreditRaw + preparedContext.oswapForInitialVaultCreditRaw,
            );
            billingTransactions!.vaultDeposit = {
              ok: true,
              skipped: false,
              txHash: receipt.hash,
              amount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
              indexedAvailableBalance: formatAmount(indexedBalance.availableBalanceRaw, billingEvmConfig.tokenDecimals),
            };
          } catch (e: any) {
            return failBilling("vaultDeposit", `Vault deposit failed: ${e.message}`);
          }
        }

        billingHeaders = await buildBillingHeaders(activeBillingWallet);
      }

      let copiedAgentId: number;
      let copiedAgentInitialCapital = Number(sourceAgent?.initialCapital ?? sourceAgent?.initial_capital ?? 0);
      const effectiveName = alias ?? sourceName;

      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = buildAgentActionSignature(
          privateKey,
          publicKey,
          params.sourceAgentId,
          "follow",
          timestamp,
        );
        const copyBody: Record<string, unknown> = {
          id: params.sourceAgentId,
          walletId: resolvedWalletId,
          buyLimit: resolvedBuyLimit,
          signature,
          timestamp,
          delegateToSettlement: true,
          settlement_config: settlementConfig,
        };
        if (alias) copyBody.alias = alias;
        if (params.order) copyBody.order = params.order;

        debugLog("deploy_copy_agent", "copy.api.req POST /api/copy-agent", copyBody);
        const res = await fetch(`${baseUrl}/api/copy-agent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            ...(billingHeaders ?? {}),
          },
          body: JSON.stringify(copyBody),
        });
        const body = await parseResponseBody(res);
        debugLog("deploy_copy_agent", "copy.api.res POST /api/copy-agent", { status: res.status, body });

        result.create = {
          ok: res.ok && body?.success !== false,
          status: res.status,
          body,
        };
        if (!res.ok || body?.success === false) {
          result.error = `copy_agent failed: ${res.status} ${responseErrorMessage(body)}`;
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }

        copiedAgentId = Number(body?.agentId);
        if (!Number.isFinite(copiedAgentId) || copiedAgentId <= 0) {
          result.error = "copy_agent succeeded but did not return a valid agentId";
          debugLog("deploy_copy_agent", "result", result);
          return textResult(result);
        }
        if (body?.initialCapital != null && Number.isFinite(Number(body.initialCapital))) {
          copiedAgentInitialCapital = Number(body.initialCapital);
        }
        (result.create as Record<string, unknown>).agentId = copiedAgentId;
        (result.create as Record<string, unknown>).initialCapital = copiedAgentInitialCapital;
      } catch (e: any) {
        result.error = e.message;
        debugLog("deploy_copy_agent", "result", result);
        return textResult(result);
      }

      try {
        const createdAt = Math.floor(Date.now() / 1000);
        const walletSignature = buildWalletActionSignature(
          privateKey,
          publicKey,
          resolvedWalletAddress,
          "authorized",
          createdAt,
          copiedAgentId,
        );
        const authorizeBody = {
          agentId: copiedAgentId,
          npub,
          walletId: resolvedWalletId,
          signature: walletSignature,
          createdAt,
        };
        debugLog("deploy_copy_agent", "wallet.api.req POST /api/wallets/authorize", authorizeBody);
        const res = await fetch(`${baseUrl}/api/wallets/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
          },
          body: JSON.stringify(authorizeBody),
        });
        const body = await parseResponseBody(res);
        debugLog("deploy_copy_agent", "wallet.api.res POST /api/wallets/authorize", { status: res.status, body });
        result.authorizeWallet = {
          ok: res.ok,
          status: res.status,
          body,
        };
        if (!res.ok) {
          warnings.push(`Wallet authorization failed after copy creation: ${responseErrorMessage(body)}`);
        }
      } catch (e: any) {
        result.authorizeWallet = { ok: false, error: e.message };
        warnings.push(`Wallet authorization failed after copy creation: ${e.message}`);
      }

      try {
        const [agentRes, settingsRes] = await Promise.all([
          fetch(`${baseUrl}/api/agent/${copiedAgentId}`),
          fetch(`${baseUrl}/api/agent/settings/${copiedAgentId}`, {
            headers: { Authorization: auth },
          }),
        ]);
        const [agentBody, settingsBody] = await Promise.all([
          parseResponseBody(agentRes),
          parseResponseBody(settingsRes),
        ]);
        debugLog("deploy_copy_agent", "verify.api.res", {
          agentStatus: agentRes.status,
          agentBody,
          settingsStatus: settingsRes.status,
          settingsBody,
        });
        result.verify = {
          ok: agentRes.ok && settingsRes.ok,
          agent: agentBody,
          settings: settingsBody,
        };
        if (!agentRes.ok || !settingsRes.ok) {
          warnings.push("Verification after copy deployment did not fully succeed.");
        }
      } catch (e: any) {
        result.verify = { ok: false, error: e.message };
        warnings.push(`Verification after copy deployment failed: ${e.message}`);
      }

      if (billingRequired && billingWallet) {
        try {
          const [postBalance, subscriptions] = await Promise.all([
            fetchBillingBalanceSnapshot(billingWallet),
            fetchBillingSubscriptions(billingWallet),
          ]);
          const matchedSubscription = subscriptions.find((subscription: any) => Number(subscription.agent_id) === copiedAgentId);
          (result.billing as any).result = {
            nftStatus: preparedContext.hasEligibleNft ? "existing_nft_verified" : "nft_minted",
            vaultDepositAmount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            updatedVaultCredit: formatAmount(postBalance.availableBalanceRaw, billingEvmConfig.tokenDecimals),
            pendingWithdrawalCredit: formatAmount(postBalance.pendingWithdrawalBalanceRaw, billingEvmConfig.tokenDecimals),
            feeBreakdown: preparedContext.prepared.fees,
            agentId: copiedAgentId,
            agentName: effectiveName,
            creationTimestamp: new Date().toISOString(),
            nextBillingDateEstimate: matchedSubscription?.next_renewal_at
              ?? new Date(Date.now() + preparedContext.billingPeriodSeconds * 1_000).toISOString(),
          };
        } catch (e: any) {
          (result.billing as any).result = {
            nftStatus: preparedContext.hasEligibleNft ? "existing_nft_verified" : "nft_minted",
            vaultDepositAmount: formatAmount(preparedContext.oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
            feeBreakdown: preparedContext.prepared.fees,
            agentId: copiedAgentId,
            agentName: effectiveName,
            creationTimestamp: new Date().toISOString(),
            nextBillingDateEstimate: new Date(Date.now() + preparedContext.billingPeriodSeconds * 1_000).toISOString(),
            warning: e.message,
          };
        }
      }

      result.warnings = Array.from(new Set(warnings));
      debugLog("deploy_copy_agent", "result", result);
      return textResult(result);
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
    description: "Delete a trading agent by ID. Delegates removal to trading-bot and settlement engine via DELETE /api/agent/:id with delegateToTradingBot and delegateToSettlement flags.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to delete" }),
    }),
    async execute(_id: string, params: { agentId: number }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const npub = Nip19.npubEncode(publicKey);
      const auth = getAuthHeader(publicKey, privateKey);
      const billingWallet = buildBillingWallet();
      const result: Record<string, unknown> = {};
      const signedAt = Math.floor(Date.now() / 1000);
      debugLog("delete_agent", "entry", { agentId: params.agentId });

      // Fetch agent to determine mode
      const agentRes = await fetch(`${baseUrl}/api/agent/${params.agentId}`);
      if (!agentRes.ok) return textResult({ error: `Agent ${params.agentId} not found: ${agentRes.status}` });
      const agentData = await agentRes.json();
      const isLive = agentData?.data?.mode === "live";

      // Step 1: Delete from trading-data (delegates to trading-bot and settlement engine)
      try {
        const sigData = { agent_id: params.agentId, action: "delete", user: npub, timestamp: signedAt };
        const signature = Signer.getSignature(sigData, privateKey, {
          agent_id: "number", action: "string", user: "string", timestamp: "number",
        } as const);
        const billingHeaders = await buildBillingHeaders(billingWallet);
        const res = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            ...billingHeaders,
          },
          body: JSON.stringify({ signature, timestamp: signedAt, delegateToTradingBot: true, delegateToSettlement: true }),
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

      // Step 1: Remove from wallet-agent (TEE)
      try {
        const body = { wallet_address: params.walletAddress, signed_at: signedAt };
        const res = await fetch(`${walletAgentUrl}/wallets/${params.walletAddress}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        debugLog("delete_wallet", "tee.res", { status: res.status });
        result.tee = { ok: res.ok };
      } catch (e: any) {
        result.tee = { ok: false, error: e.message };
      }

      // Step 2: Remove from trading-data
      try {
        const createdAt = signedAt;
        const sigData = { created_at: createdAt, wallet_address: params.walletAddress, action: "disconnected", npub };
        const signature = Signer.getSignature(sigData, privateKey, {
          created_at: "number", wallet_address: "string", action: "string", npub: "string",
        } as const);
        const res = await fetch(`${baseUrl}/api/wallets`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ npub, walletAddress: params.walletAddress, signature, createdAt, agents: [] }),
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

  // ── Backtest tools ──────────────────────────────────────────────

  api.registerTool({
    name: "create_backtest",
    description:
      "Create a new backtest job for an agent. " +
      "If the user mentions a timezone, OpenClaw should resolve it before calling the tool. " +
      "If `startTime` and/or `endTime` are omitted, the plugin defaults to a rolling 30-day window.",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to backtest" }),
      initialCapital: Type.Number({ description: "Initial capital amount" }),
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
      strategy: Type.Optional(Strategy),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
        initialCapital: number;
        startTime?: string | number;
        endTime?: string | number;
        timeZone?: string;
        protocolFee?: number;
        gasFee?: number;
        strategy?: Record<string, unknown>;
      },
    ) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const billingWallet = buildBillingWallet();
      const billingHeaders = await buildBillingHeaders(billingWallet);

      const normalizedRange = normalizeBacktestTimeRange(
        params.startTime,
        params.endTime,
        params.timeZone,
      );
      debugLog("create_backtest", "normalized-range", {
        agentId: params.agentId,
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
        agentId: params.agentId,
        initialCapital: params.initialCapital,
        startTime: normalizedRange.startTime,
        endTime: normalizedRange.endTime,
      };
      if (params.protocolFee != null) payload.protocolFee = params.protocolFee;
      if (params.gasFee != null) payload.gasFee = params.gasFee;
      if (params.strategy) payload.strategy = params.strategy;

      const res = await fetch(`${baseUrl}/api/backtest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
          ...billingHeaders,
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
    description: "List backtests for an agent",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID" }),
    }),
    async execute(_id: string, params: { agentId: number }) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);

      const res = await fetch(`${baseUrl}/api/backtests/${params.agentId}`, {
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
      const res = await fetch(`${baseUrl}/api/backtest-job/${params.jobId}`);
      if (!res.ok) throw new Error(`get_backtest_job failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  api.registerTool({
    name: "get_backtest_result",
    description: "Get the full result of a completed backtest job (portfolio, metrics, trades)",
    parameters: Type.Object({
      jobId: Type.String({ description: "Backtest job ID" }),
    }),
    async execute(_id: string, params: { jobId: string }) {
      const res = await fetch(`${baseUrl}/api/backtest-job/${params.jobId}/result`);
      if (!res.ok) throw new Error(`get_backtest_result failed: ${res.status}`);
      return textResult(sanitizeBacktestResultResponse(await res.json(), params.jobId));
    },
  });

  // ── Fill execution notifications ─────────────────────────────────
  registerFillNotifications(api, pluginConfig, debugLog);
}
