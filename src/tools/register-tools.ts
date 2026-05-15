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
import { SimulationConfig, SimulationConfigPatch, Strategy } from "../schemas/strategy.js";
import { registerFillNotifications } from "./register-fill-notifications.js";
import type { EthHeaders, PreparedAgentCreationContext } from "../types/billing.js";
import { getAuthHeader, loadKeys, persistKeyToConfig } from "../utils/auth.js";
import { sanitizeBacktestResultResponse, WEB_URL } from "../utils/backtest-result.js";
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

function buildBillingBreakdown(
  preparedContext: PreparedAgentCreationContext,
  billingEvmConfig: { networkLabel: string; tokenSymbol: string },
) {
  const wallet = preparedContext.prepared.wallet;
  const fees = preparedContext.prepared.fees;
  const funding = preparedContext.prepared.funding;
  const gas = preparedContext.prepared.gas;
  const tokenSymbol = wallet.tokenSymbol ?? billingEvmConfig.tokenSymbol;
  const bnbForSwapMax = funding?.bnbForSwapMax ?? "0";
  const bnbForGas = funding?.bnbForGas ?? "0";
  const totalBnbNeeded = funding?.totalBnbNeeded ?? "0";
  const bnbShortfall = funding?.bnbShortfall ?? "0";
  const oswapShortfall = fees.oswapShortfall ?? "0";

  let summary = `Need up to ${totalBnbNeeded} BNB total on ${wallet.networkLabel ?? billingEvmConfig.networkLabel}.`;
  if (Number(oswapShortfall) > 0) {
    summary =
      `Need up to ${totalBnbNeeded} BNB total on ${wallet.networkLabel ?? billingEvmConfig.networkLabel}: ` +
      `${bnbForSwapMax} BNB max to swap into ${oswapShortfall} ${tokenSymbol} plus ${bnbForGas} BNB for gas.`;
  } else if (Number(bnbShortfall) > 0) {
    summary =
      `Existing ${tokenSymbol} covers billing. Need ${bnbForGas} BNB for gas on ${wallet.networkLabel ?? billingEvmConfig.networkLabel}.`;
  } else {
    summary = `Existing ${tokenSymbol} and BNB balances already cover the setup on ${wallet.networkLabel ?? billingEvmConfig.networkLabel}.`;
  }

  return {
    summary,
    network: wallet.networkLabel ?? billingEvmConfig.networkLabel,
    tokenSymbol,
    billingWalletAddress: wallet.address ?? null,
    billingVaultAddress: wallet.vaultAddress ?? null,
    billingTokenAddress: wallet.tokenAddress ?? null,
    walletBalances: {
      oswap: wallet.oswapBalance ?? null,
      bnb: wallet.bnbBalance ?? null,
    },
    fees: {
      operatingFee: fees.operatingFee,
      protocolFee: fees.protocolFee,
      strategyFee: fees.strategyFee,
      firstBillingAmount: fees.firstBillingAmount,
      existingVaultCredit: fees.existingVaultCredit,
      targetVaultCredit: fees.targetVaultCredit,
      oswapForNft: fees.oswapForNft,
      oswapForInitialVaultCredit: fees.oswapForInitialVaultCredit,
      requiredOswap: fees.requiredOswap,
      oswapShortfall,
    },
    funding: funding
      ? {
          bnbForSwapQuoted: funding.bnbForSwapQuoted,
          bnbForSwapMax,
          bnbForGas,
          totalBnbNeeded,
          bnbShortfall,
        }
      : null,
    gas: gas
      ? {
          gasPriceGwei: gas.gasPriceGwei,
          steps: gas.steps,
        }
      : null,
  };
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

      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const url = `${baseUrl}/api/transactions/${params.agentId}${qs.toString() ? `?${qs}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: auth } });
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
        isPrivate?: boolean;
        copiedFromAgentId?: number;
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
        if (hasOwnField(params, "isPrivate")) body.isPrivate = params.isPrivate;
        if (hasOwnField(params, "copiedFromAgentId")) body.copiedFromAgentId = params.copiedFromAgentId;

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

      // Step 1: Prepare encryption payload for wallet-agent delegation
      // (trading-data forwards to wallet-agent TEE when delegateToWalletAgent is true)
      let agentWalletAddress: string;
      let walletAgentPublicKey = "";
      let teeEncryptedPrivateKey = "";
      let walletAgentSignedAt = 0;
      try {
        const pubKeyRes = await fetch(`${walletAgentUrl}/pubkey`);
        if (!pubKeyRes.ok) throw new Error(`Failed to get wallet-agent pubkey: ${pubKeyRes.status}`);
        const { publicKey: walletAgentPubKey } = await pubKeyRes.json();
        walletAgentPublicKey = walletAgentPubKey;

        const ephemeralKey = Keys.generatePrivateKey();
        const ephemeralPubKey = Keys.getPublicKey(ephemeralKey);
        const encrypted = await Crypto.encryptSharedMessage(
          ephemeralKey,
          walletAgentPubKey,
          params.ethAgentPrivateKey,
        );
        teeEncryptedPrivateKey = `${encrypted}&pbk=02${ephemeralPubKey}`;
        walletAgentSignedAt = Math.floor(Date.now() / 1000);

        // Derive the agent wallet address locally from the private key
        const ethWallet = new Wallet("0x" + params.ethAgentPrivateKey);
        agentWalletAddress = ethWallet.address;
        debugLog("setup_live_wallet", "prepare.delegation", { agentWalletAddress, walletAgentPublicKey });

        result.teeStorage = { ok: true, agentWalletAddress, delegated: true };
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
          delegateToWalletAgent: true,
          walletAgentPublicKey,
          encryptedPrivateKey: teeEncryptedPrivateKey,
          walletAgentSignedAt,
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
    description: "Read-only preflight for agent creation (direct or copy). Uses the user's nostrPrivateKey as the BSC/Ethereum signer, ensures the billing wallet is registered via /api/auth/login, determines whether upfront billing setup is required, loads active /api/nft-config eligibility, calculates OSWAP and vault credit requirements when needed, estimates BNB and gas needs, and returns the full execution plan before any on-chain transaction. OpenClaw must present this result to the user and get explicit confirmation before calling deploy_agent.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"', default: "spot" })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
      sourceAgentId: Type.Optional(Type.Number({ description: "When copying an existing public agent, pass the source agent ID. symbol and marketType are resolved from the source; do not pass them separately." })),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        mode?: string;
        marketType?: string;
        symbol?: string;
        sourceAgentId?: number;
      },
    ) {
      const { privateKey, npub, publicKey } = loadKeys(pluginConfig);
      debugLog("prepare_agent_creation", "entry", {
        name: params.name,
        mode: params.mode ?? "paper",
        marketType: params.marketType ?? "spot",
        symbol: params.symbol,
        sourceAgentId: params.sourceAgentId,
        usesNostrPrivateKey: true,
      });
      if (params.sourceAgentId) {
        let sourceAgent: any;
        try {
          sourceAgent = await fetchPublicAgentProfile(params.sourceAgentId);
        } catch (e: any) {
          return textResult({ error: e.message });
        }
        const sourceSymbol = typeof sourceAgent?.pair === "string" && sourceAgent.pair.trim()
          ? sourceAgent.pair.trim()
          : typeof sourceAgent?.symbol === "string" && sourceAgent.symbol.trim()
            ? sourceAgent.symbol.trim()
            : undefined;
        if (!sourceSymbol) {
          return textResult({ error: `Source agent ${params.sourceAgentId} is missing a trading pair; cannot prepare copy deployment` });
        }
        const sourceMarketType: "spot" | "perp" = sourceAgent?.marketType === "perp" ? "perp" : "spot";
        const effectiveMode: string = params.mode ?? sourceAgent?.mode ?? "paper";
        try {
          const prepared = await prepareAgentCreationContext({
            name: params.name,
            mode: effectiveMode,
            marketType: sourceMarketType,
            symbol: sourceSymbol,
            agentId: params.sourceAgentId,
            npub,
            publicKey,
            privateKey,
          });
          return textResult({
            ...prepared.prepared,
            sourceAgent: {
              id: params.sourceAgentId,
              name: sourceAgent?.name ?? null,
              pair: sourceSymbol,
              mode: sourceAgent?.mode ?? null,
              marketType: sourceMarketType,
            },
            confirmationRequired: true,
            nextStep: "present_checkout_and_wait_for_explicit_confirmation",
          });
        } catch (e: any) {
          return textResult({ error: e.message });
        }
      }
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
        return textResult({
          ...prepared.prepared,
          confirmationRequired: true,
          nextStep: "present_checkout_and_wait_for_explicit_confirmation",
        });
      } catch (e: any) {
        return textResult({ error: e.message });
      }
    },
  });


  api.registerTool({
    name: "deploy_agent",
    description: "Create a trading agent, performing the full billing preflight and any required active NFT/vault setup before agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer and ensures the billing wallet is registered via /api/auth/login before billing checks. Uses delegateToTradingBot and delegateToSettlement flags on POST /api/agent so the server handles all downstream syncing internally. Call this only after a separate preflight has been shown to the user and the user has explicitly confirmed creation.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      initialCapital: Type.Optional(Type.Number({ description: "Initial capital amount (auto-fetched for live mode)" })),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"', default: "spot" })),
      strategy: Type.Optional(Strategy),
      strategyDescription: Type.Optional(Type.String({ description: "Human-readable strategy summary" })),
      sourceAgentId: Type.Optional(Type.Number({ description: "When creating a copy agent, pass the source public agent ID. Strategy is resolved from the source automatically via copiedFromAgentId; do not pass strategy when sourceAgentId is provided." })),
      assetType: Type.Optional(Type.String({ description: '"crypto" or "stocks". Asset type for paper-mode simulation (used when delegateToTradingBot is true).' })),
      walletAddress: Type.Optional(Type.String({ description: "Agent wallet address (live mode)" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Master wallet address (live mode, for settlement)" })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
      chainId: Type.Optional(Type.Number({ description: "Network chain ID for both paper and live modes (e.g. Hyperliquid: 998/999, EVM: 1/56)." })),
      leverage: Type.Optional(Type.Number({ description: "Leverage multiplier" })),
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
        sourceAgentId?: number;
        assetType?: string;
        walletAddress?: string;
        masterWalletAddress?: string;
        symbol?: string;
        chainId?: number;
        leverage?: number;
        isPrivate?: boolean;
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
          confirmationRequired: true,
          transactions: billingTransactions,
        };

        if (preparedContext.bnbShortfallRaw > 0n) {
          return textResult({
            error: `Insufficient BNB on ${billingEvmConfig.networkLabel}. Shortfall: ${formatAmount(preparedContext.bnbShortfallRaw, 18, 8)} BNB. Fund the billing wallet on ${billingEvmConfig.networkLabel}, not another chain.`,
            billingShortfall: buildBillingBreakdown(preparedContext, billingEvmConfig),
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
        if (params.sourceAgentId != null) payload.copiedFromAgentId = params.sourceAgentId;
        if (params.walletAddress) payload.walletAddress = params.walletAddress;
        if (params.symbol) payload.symbol = params.symbol;
        if (settlementConfig) payload.settlement_config = settlementConfig;
        payload.delegateToTradingBot = true;
        if (isLive) payload.delegateToSettlement = true;
        if (hasOwnField(params, "isPrivate")) payload.isPrivate = params.isPrivate;

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
        agentUrl = `${WEB_URL}/trading-agents/${publicKey}/${agentId}`;
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
    name: "search_public_agents",
    description: "Search public trading agents by name using /api/agents/search. Use this when a user references an agent by name but the source agent ID is unknown.",
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
      const agentRes = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
        headers: { Authorization: auth },
      });
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

      // Remove from trading-data (delegateToWalletAgent instructs server to also remove from TEE)
      try {
        const createdAt = signedAt;
        const sigData = { created_at: createdAt, wallet_address: params.walletAddress, action: "disconnected", npub };
        const signature = Signer.getSignature(sigData, privateKey, {
          created_at: "number", wallet_address: "string", action: "string", npub: "string",
        } as const);
        const res = await fetch(`${baseUrl}/api/wallets`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ npub, walletAddress: params.walletAddress, signature, createdAt, agents: [], delegateToWalletAgent: true, walletAgentSignedAt: signedAt }),
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
      const billingWallet = buildBillingWallet();
      const billingHeaders = await buildBillingHeaders(billingWallet);

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
      "Mode 'link' returns only a URL to the agent's page on agent.openswap.xyz (requires agentId).",
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

  // ── Fill execution notifications ─────────────────────────────────
  registerFillNotifications(api, pluginConfig, debugLog);
}
