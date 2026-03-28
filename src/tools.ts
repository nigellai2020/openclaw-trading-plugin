import { Type } from "@sinclair/typebox";
import { Keys, Nip19, Signer, Crypto } from "@scom/scom-signer";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
  parseUnits,
} from "ethers";
import mqtt from "mqtt";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBillingStageParams, type BillingEnvironment } from "./billing-stage.js";
import { decideUpdateAgentBilling, type UpdateAgentBillingRequirement } from "./update-agent-billing.js";
import { SUPPORTED_PAIRS } from "./supported-pairs.js";

// ── Strategy schema ────────────────────────────────────────────────

const IndicatorConfig = Type.Object({
  type: Type.String({ description: 'Indicator type: "rsi","sma","ema","macd","stochrsi","stochastic","bollinger","atr","renko","renko_atr","ohlc". Outputs — single-value (rsi,sma,ema,atr): {name}. macd: {name}.macd, {name}.signal, {name}.histogram. stochrsi/stochastic: {name}.k, {name}.d. bollinger: {name}.upper, {name}.middle, {name}.lower. renko/renko_atr: {name}.brick_high, {name}.brick_low, {name}.direction. ohlc: {name}.open, {name}.high, {name}.low, {name}.close, {name}.volume. Use "price" for live tick price (no indicator needed).' }),
  name: Type.String({ description: 'Unique name referenced in rules, e.g. "ema_20_M15"' }),
  period: Type.Optional(Type.Number({ description: "Period/length (required for most)" })),
  timeframe: Type.Optional(Type.String({ description: '"M1","M5","M15","M30","H1","H4","D1"' })),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Extra params. EMA/SMA/RSI: {period}. MACD: {fast_period,slow_period,signal_period}. Bollinger: {period,std_dev}. StochRSI: {rsi_period,stoch_period,k_period,d_period}. ATR: {period,multiplier}. Renko: {brick_size}. RenkoATR: {atr_period,atr_multiplier}.',
  })),
});

const SizeConfig = Type.Object({
  mode: Type.String({ description: '"all","fixed_usd","percent","shares","fixed_asset"' }),
  value: Type.Optional(Type.Number()),
});

const OrderConfig = Type.Object({
  type: Type.String({ description: '"market"' }),
  side: Type.Optional(Type.String({ description: '"long" or "short" — required for both open and close rules (must match the position side being opened/closed)' })),
  size: Type.Optional(SizeConfig),
});

const CopyTradeOrderConfig = Type.Object({
  type: Type.String({ description: '"market"' }),
  size: SizeConfig,
});

const PyramidingConfig = Type.Object({
  enabled: Type.Boolean(),
  max_legs: Type.Number(),
});

const RuleConfig = Type.Object({
  id: Type.String({ description: "Unique rule ID" }),
  intent: Type.String({ description: '"open" or "close"' }),
  when: Type.Unknown({
    description: 'Condition. Simple: {"indicator":"rsi14","op":"lt","value":30}. Cross: {"indicator":"ema20","op":"crosses_above","other":"ema50"}. AND: {"all":[...]}. OR: {"any":[...]}. Profit: {"profit":{"mode":"percent","value":5}}. Age: {"position_age_secs":300}. Ops: lt,le,gt,ge,eq,ne,crosses_above,crosses_below.',
  }),
  order: Type.Optional(OrderConfig),
  pyramiding: Type.Optional(PyramidingConfig),
});

const StopLossTakeProfit = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.String({ description: '"percent","absolute","atr"' })),
  value: Type.Optional(Type.Number()),
  atr_indicator: Type.Optional(Type.String()),
});

const TrailingStopConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  start_mode: Type.Optional(Type.String({ description: '"atr" or "percent"' })),
  start_value: Type.Optional(Type.Number()),
  distance_mode: Type.Optional(Type.String({ description: '"breakeven","atr","percent"' })),
  distance_value: Type.Optional(Type.Number()),
  atr_indicator: Type.Optional(Type.String()),
});

const PerBarLimit = Type.Object({
  timeframe: Type.String({ description: '"M1","M5","M15","M30","H1","H4","D1"' }),
  max_trades: Type.Number(),
});

const RiskManagerConfig = Type.Object({
  stop_loss: Type.Optional(StopLossTakeProfit),
  take_profit: Type.Optional(StopLossTakeProfit),
  trailing_stop: Type.Optional(TrailingStopConfig),
  cooldown: Type.Optional(Type.Object({ entry_secs: Type.Optional(Type.Number()) })),
  per_bar_limits: Type.Optional(Type.Array(PerBarLimit)),
  leverage: Type.Optional(Type.Number({ description: "Leverage multiplier" })),
});

const Strategy = Type.Object({
  name: Type.String({ description: "Strategy name" }),
  symbol: Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' }),
  indicators: Type.Array(IndicatorConfig),
  rules: Type.Array(RuleConfig),
  risk_manager: Type.Optional(RiskManagerConfig),
});

const SimulationConfig = Type.Object({
  asset_type: Type.String({ description: '"crypto" or "stocks"' }),
  protocol: Type.Optional(Type.String({ description: '"uniswap" or "hyperliquid" (required when asset_type is "crypto")' })),
  chain_id: Type.Optional(Type.Number({ description: "Uniswap: 1 (Ethereum), 56 (BSC), 8453 (Base), 42161 (Arbitrum). Hyperliquid: 998 (testnet), 999 (mainnet). Not needed for stocks." })),
});

const SimulationConfigPatch = Type.Object({
  asset_type: Type.Optional(Type.String({ description: 'Optional partial update for simulation asset type: "crypto" or "stocks"' })),
  protocol: Type.Optional(Type.String({ description: 'Optional partial update for simulation protocol: "uniswap" or "hyperliquid"' })),
  chain_id: Type.Optional(Type.Number({ description: "Optional partial update for simulation chain ID" })),
});

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://agent02.decom.dev";
const DEFAULT_BOT_URL =
  "https://trading-agent.decom.dev";
const DEFAULT_BACKTEST_ENGINE_URL = "https://mcp-backtest01.decom.dev";
const DEFAULT_WALLET_AGENT_URL =
  "https://wallet-agent.decom.dev";
const DEFAULT_SETTLEMENT_ENGINE_URL =
  "https://settlement-agent.decom.dev";
const DEFAULT_BSC_BILLING_RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545";
const DEFAULT_BSC_ROUTER_ADDRESS = "0x8AEb7abBCfe0ED8baAfa3ddD2CdE39cDBb4d0106";
const DEFAULT_BSC_WETH_ADDRESS = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
const DEFAULT_OSWAP_TOKEN_ADDRESS = "0x45eee762aaeA4e5ce317471BDa8782724972Ee19";
const DEFAULT_BSC_VAULT_ADDRESS = "0x15780a63c8a47dd27c4c7f7d17673929e0cb4d05";
const DEFAULT_ELIGIBLE_NFT_ADDRESS = "0xc32c70c6cc2338daa3fdfbb25c98f1227c673175";
const DEFAULT_ELIGIBLE_NFT_EXPLORER_URL = "https://testnet.bscscan.com/address/0xc32c70c6cc2338daa3fdfbb25c98f1227c673175";
const DEFAULT_ELIGIBLE_NFT_NAME = "Troll NFT";
const DEFAULT_ELIGIBLE_NFT_MINIMUM_STAKE = 20;
const DEFAULT_ELIGIBLE_NFT_PROTOCOL_FEE = 10;
const DEFAULT_ELIGIBLE_NFT_TOTAL_MINTING_FEE = 30;
const DEFAULT_BILLING_SWAP_SLIPPAGE_BPS = 50;
const DEFAULT_BILLING_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BILLING_POLL_TIMEOUT_MS = 90_000;
const DEFAULT_FALLBACK_SWAP_GAS = 250_000n;
const DEFAULT_FALLBACK_APPROVE_GAS = 70_000n;
const DEFAULT_FALLBACK_NFT_STAKE_GAS = 300_000n;
const DEFAULT_FALLBACK_VAULT_DEPOSIT_GAS = 220_000n;
const DEFAULT_LIVE_LEVERAGE = 3;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const NFT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function stake(uint256 amount)",
];

const VAULT_ABI = [
  "function deposit(address beneficiary, uint256 amount)",
];

const ROUTER_ABI = [
  "function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint256[] memory amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)",
];

type BillingEvmConfig = {
  environment: BillingEnvironment;
  networkLabel: string;
  rpcUrl: string;
  routerAddress: string;
  wethAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  vaultAddress: string;
  eligibleNftAddress: string;
  eligibleNftExplorerUrl: string;
  eligibleNftName: string;
  eligibleNftMinimumStake: number;
  eligibleNftProtocolFee: number;
  eligibleNftTotalMintingFee: number;
  swapSlippageBps: number;
  balancePollIntervalMs: number;
  balancePollTimeoutMs: number;
};

type EthHeaders = {
  "x-eth-message": string;
  "x-eth-signature": string;
};

type GasEstimateSummary = {
  required: boolean;
  gasUnits: string;
  costBnb: string;
  source: "rpc" | "fallback" | "skipped";
};

type PreparedAgentCreationResult = {
  identity: {
    npub: string;
    publicKey: string;
  };
  billing: {
    required: boolean;
    bypassed: boolean;
    canSkipNftPurchase: boolean;
  };
  wallet: {
    address?: string;
    oswapBalance?: string;
    bnbBalance?: string;
    networkLabel?: string;
    usesNostrPrivateKey: boolean;
  };
  nft: {
    required: boolean;
    hasEligibleNft: boolean;
    eligibleOptions: Array<{
      name: string;
      contractAddress: string;
      explorerUrl: string;
      minimumStake: string;
      protocolFee: string;
      totalMintingFee: string;
    }>;
  };
  fees: {
    operatingFee: string;
    protocolFee: string;
    strategyFee: string;
    firstBillingAmount: string;
    existingVaultCredit: string;
    targetVaultCredit: string;
    oswapForNft: string;
    oswapForInitialVaultCredit: string;
    requiredOswap: string;
    oswapShortfall: string;
    note: string;
  };
  subscription?: {
    estimatedEndTime: string;
    renewalPeriodDays: number;
    renewalAmount: string;
  };
  funding?: {
    bnbForSwapQuoted: string;
    bnbForSwapMax: string;
    bnbForGas: string;
    totalBnbNeeded: string;
    bnbShortfall: string;
  };
  approvals?: {
    nftApprovalRequired: boolean;
    vaultApprovalRequired: boolean;
  };
  gas?: {
    gasPriceWei: string;
    gasPriceGwei: string;
    steps: {
      swap: GasEstimateSummary;
      nftApproval: GasEstimateSummary;
      nftMint: GasEstimateSummary;
      vaultApproval: GasEstimateSummary;
      vaultDeposit: GasEstimateSummary;
    };
  };
  executionPlan: {
    agentName: string;
    mode: string;
    marketType: string;
    symbol: string | null;
    actions: string[];
    approvals: string[];
    depositToVault: string;
  };
};

type PreparedAgentCreationContext = {
  prepared: PreparedAgentCreationResult;
  billingWallet?: Wallet;
  operatingFeeRaw: bigint;
  protocolFeeRaw: bigint;
  strategyFeeRaw: bigint;
  firstBillingAmountRaw: bigint;
  existingVaultCreditRaw: bigint;
  targetVaultCreditRaw: bigint;
  oswapForNftRaw: bigint;
  oswapForInitialVaultCreditRaw: bigint;
  requiredOswapRaw: bigint;
  oswapShortfallRaw: bigint;
  walletOswapBalanceRaw: bigint;
  walletBnbBalanceRaw: bigint;
  bnbForSwapQuotedRaw: bigint;
  bnbForSwapMaxRaw: bigint;
  bnbForGasRaw: bigint;
  totalBnbNeededRaw: bigint;
  bnbShortfallRaw: bigint;
  gasPriceWei: bigint;
  hasEligibleNft: boolean;
  nftApprovalRequired: boolean;
  vaultApprovalRequired: boolean;
  billingPeriodSeconds: number;
  selectedEligibleNft?: EligibleNftConfig;
  ownedEligibleNft?: EligibleNftConfig;
};

type EligibleNftConfig = {
  id: string;
  name: string;
  contractAddress: string;
  explorerUrl: string;
  minimumStakeRaw: bigint;
  protocolFeeRaw: bigint;
  totalMintingFeeRaw: bigint;
  minimumStake: string;
  protocolFee: string;
  totalMintingFee: string;
  sortIndex: number;
};

function normalizeHexPrivateKey(privateKey: string): string {
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

function trimAmount(value: string, maxDecimals = 6): string {
  if (!value.includes(".")) return value;
  const [whole, fraction] = value.split(".");
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function formatAmount(raw: bigint, decimals: number, maxDecimals = 6): string {
  return trimAmount(formatUnits(raw, decimals), maxDecimals);
}

function parseTokenAmount(raw: string | number, decimals: number): bigint {
  return parseUnits(String(raw), decimals);
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function computeAmountInMax(quotedIn: bigint, slippageBps: number): bigint {
  return (quotedIn * BigInt(10_000 + slippageBps)) / 10_000n;
}

function makeBillingAccessMessage(walletAddress: string, timestamp: number): string {
  return `Billing engine access; wallet: ${walletAddress}; timestamp: ${timestamp}`;
}

function makeBillingWalletLoginMessage(npub: string, timestamp: number): string {
  return `OSWap login npub: ${npub} timestamp: ${timestamp}`;
}

function sanitizeForLog(data: unknown): unknown {
  const secretPattern = /(privatekey|signature|authorization|encrypted_private_key|ethmessage|message)/i;
  if (data == null) return data;
  if (Array.isArray(data)) return data.map((item) => sanitizeForLog(item));
  if (typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => {
        if (secretPattern.test(key)) return [key, "[REDACTED]"];
        return [key, sanitizeForLog(value)];
      }),
    );
  }
  return data;
}

function buildBillingEvmConfig(pluginConfig: any): BillingEvmConfig {
  const stage = resolveBillingStageParams(pluginConfig.billingEnvironment);
  return {
    environment: stage.environment,
    networkLabel: stage.networkLabel,
    rpcUrl: pluginConfig.bscBillingRpcUrl ?? DEFAULT_BSC_BILLING_RPC_URL,
    routerAddress: pluginConfig.bscBillingRouterAddress ?? DEFAULT_BSC_ROUTER_ADDRESS,
    wethAddress: pluginConfig.bscBillingWethAddress ?? DEFAULT_BSC_WETH_ADDRESS,
    tokenAddress: pluginConfig.bscBillingTokenAddress ?? DEFAULT_OSWAP_TOKEN_ADDRESS,
    tokenSymbol: pluginConfig.bscBillingTokenSymbol ?? "OSWAP",
    tokenDecimals: pluginConfig.bscBillingTokenDecimals ?? 18,
    vaultAddress: pluginConfig.bscBillingVaultAddress ?? DEFAULT_BSC_VAULT_ADDRESS,
    eligibleNftAddress: pluginConfig.bscEligibleNftAddress ?? DEFAULT_ELIGIBLE_NFT_ADDRESS,
    eligibleNftExplorerUrl: pluginConfig.bscEligibleNftExplorerUrl ?? DEFAULT_ELIGIBLE_NFT_EXPLORER_URL,
    eligibleNftName: pluginConfig.bscEligibleNftName ?? DEFAULT_ELIGIBLE_NFT_NAME,
    eligibleNftMinimumStake: pluginConfig.bscEligibleNftMinimumStake ?? DEFAULT_ELIGIBLE_NFT_MINIMUM_STAKE,
    eligibleNftProtocolFee: pluginConfig.bscEligibleNftProtocolFee ?? DEFAULT_ELIGIBLE_NFT_PROTOCOL_FEE,
    eligibleNftTotalMintingFee: pluginConfig.bscEligibleNftTotalMintingFee ?? DEFAULT_ELIGIBLE_NFT_TOTAL_MINTING_FEE,
    swapSlippageBps: pluginConfig.billingSwapSlippageBps ?? DEFAULT_BILLING_SWAP_SLIPPAGE_BPS,
    balancePollIntervalMs: pluginConfig.billingPollIntervalMs ?? DEFAULT_BILLING_POLL_INTERVAL_MS,
    balancePollTimeoutMs: pluginConfig.billingPollTimeoutMs ?? DEFAULT_BILLING_POLL_TIMEOUT_MS,
  };
}

function buildExplorerUrl(templateUrl: string, configuredAddress: string, contractAddress: string): string {
  const normalizedConfiguredAddress = configuredAddress.toLowerCase();
  if (templateUrl.toLowerCase().includes(normalizedConfiguredAddress)) {
    return templateUrl.replace(new RegExp(configuredAddress, "ig"), contractAddress);
  }

  try {
    const url = new URL(templateUrl);
    if (url.pathname.startsWith("/address/")) {
      url.pathname = `/address/${contractAddress}`;
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {}

  return `https://testnet.bscscan.com/address/${contractAddress}`;
}

function isActiveNftConfig(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

async function estimateStepCost(
  gasEstimator: () => Promise<bigint>,
  gasPriceWei: bigint,
  fallbackGas: bigint,
  required: boolean,
): Promise<GasEstimateSummary> {
  if (!required) {
    return {
      required: false,
      gasUnits: "0",
      costBnb: "0",
      source: "skipped",
    };
  }

  try {
    const gasUnits = await gasEstimator();
    return {
      required: true,
      gasUnits: gasUnits.toString(),
      costBnb: formatAmount(gasUnits * gasPriceWei, 18, 8),
      source: "rpc",
    };
  } catch {
    return {
      required: true,
      gasUnits: fallbackGas.toString(),
      costBnb: formatAmount(fallbackGas * gasPriceWei, 18, 8),
      source: "fallback",
    };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function loadKeys(config: any): {
  privateKey: string;
  publicKey: string;
  npub: string;
} {
  const pk = config?.nostrPrivateKey || undefined;

  if (!pk)
    throw new Error(
      "No Nostr key configured. Run get_or_create_nostr_keys first.",
    );

  const publicKey = Keys.getPublicKey(pk);
  return { privateKey: pk, publicKey, npub: Nip19.npubEncode(publicKey) };
}

function getAuthHeader(pubkey: string, privateKey: string): string {
  const sig = Signer.getSignature(
    { pubkey },
    privateKey,
    { pubkey: "string" } as const,
  );
  return `Bearer ${pubkey}:${sig}`;
}

function persistKeyToConfig(privateKey: string): boolean {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

  const entry = ((cfg.plugins ??= {}).entries ??= {})["trading-plugin"] ??= {};
  const config = (entry.config ??= {});
  if (config.nostrPrivateKey) return false;

  config.nostrPrivateKey = privateKey;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

type BacktestNormalizedTimeRange = {
  startTime: string;
  endTime: string;
  timeZoneUsed: string;
  timeZoneSource:
    | "explicit-timezone-parameter"
    | "runtime-timezone"
    | "explicit-input-offset";
};

type ParsedLocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.(\d{1,3}))?)?$/;
const NUMERIC_TIMESTAMP_RE = /^\d{10,16}$/;
const EXPLICIT_TIMEZONE_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const EXPLICIT_OFFSET_CAPTURE_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const AMBIGUOUS_TIMEZONE_ABBREVIATIONS = new Set([
  "est",
  "edt",
  "cst",
  "cdt",
  "mst",
  "mdt",
  "pst",
  "pdt",
  "bst",
]);
const COMMON_TIMEZONE_ALIASES: Record<string, string> = {
  utc: "UTC",
  gmt: "UTC",
  "hk time": "Asia/Hong_Kong",
  hk: "Asia/Hong_Kong",
  hkt: "Asia/Hong_Kong",
  "hong kong": "Asia/Hong_Kong",
  "hong kong time": "Asia/Hong_Kong",
  "toronto time": "America/Toronto",
  toronto: "America/Toronto",
  "new york time": "America/New_York",
  "new york": "America/New_York",
};

type BacktestNormalizedTime = {
  iso: string;
  usedExplicitOffset: boolean;
  explicitOffset?: string;
};

function resolveRuntimeTimeZone(): string {
  const intlTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (intlTimeZone) return intlTimeZone;
  if (typeof process.env.TZ === "string" && process.env.TZ.trim()) {
    return process.env.TZ.trim();
  }
  return "UTC";
}

function toInt(value: string, label: string, originalInput: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${label} in backtest time: ${originalInput}`);
  }
  return parsed;
}

function canonicalizeTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Unsupported timeZone: "${timeZone}"`);
  }
}

function resolveBacktestTimeZoneOverride(timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  const normalized = timeZone.trim();
  if (!normalized) return undefined;
  const key = normalized.toLowerCase().replace(/\s+/g, " ");
  if (AMBIGUOUS_TIMEZONE_ABBREVIATIONS.has(key)) {
    throw new Error(`Ambiguous timeZone "${timeZone}". Use an IANA zone like "Asia/Hong_Kong" or a clearer phrase like "Hong Kong time"`);
  }
  const alias = COMMON_TIMEZONE_ALIASES[key];
  return canonicalizeTimeZone(alias ?? normalized);
}

function parseDateOnly(value: string): ParsedLocalDateTime | null {
  const match = value.match(DATE_ONLY_RE);
  if (!match) return null;
  const [, year, month, day] = match;
  return {
    year: toInt(year, "year", value),
    month: toInt(month, "month", value),
    day: toInt(day, "day", value),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function parseNaiveDateTime(value: string): ParsedLocalDateTime | null {
  const match = value.match(NAIVE_DATETIME_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", , fraction = ""] = match;
  return {
    year: toInt(year, "year", value),
    month: toInt(month, "month", value),
    day: toInt(day, "day", value),
    hour: toInt(hour, "hour", value),
    minute: toInt(minute, "minute", value),
    second: toInt(second, "second", value),
    millisecond: toInt(fraction.padEnd(3, "0"), "millisecond", value),
  };
}

const backtestTimeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getBacktestTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = backtestTimeZoneFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  backtestTimeZoneFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedParts(date: Date, timeZone: string): ParsedLocalDateTime {
  const formatter = getBacktestTimeZoneFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`Unable to resolve ${type} in timezone ${timeZone}`);
    }
    return Number(value);
  };
  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
    millisecond: date.getUTCMilliseconds(),
  };
}

function sameParsedLocalDateTime(a: ParsedLocalDateTime, b: ParsedLocalDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

function getTimeZoneOffsetMillis(instantMs: number, timeZone: string): number {
  const date = new Date(instantMs);
  const zoned = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    zoned.millisecond,
  );
  return zonedAsUtc - instantMs;
}

function buildZonedDate(
  parts: ParsedLocalDateTime,
  originalInput: string,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  let instantMs = utcGuess;
  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMillis(instantMs, timeZone);
    const adjusted = utcGuess - offset;
    if (adjusted === instantMs) break;
    instantMs = adjusted;
  }

  const date = new Date(instantMs);
  if (!sameParsedLocalDateTime(getZonedParts(date, timeZone), parts)) {
    throw new Error(`Invalid backtest time "${originalInput}" in timezone ${timeZone}`);
  }
  return date;
}

function normalizeBacktestTimeInput(
  rawInput: string | number,
  kind: "start" | "end",
  timeZone: string,
): BacktestNormalizedTime {
  if (typeof rawInput === "number") {
    if (!Number.isFinite(rawInput)) {
      throw new Error(`Invalid ${kind}Time: must be a finite ISO datetime, date-only value, or unix timestamp`);
    }
    const millis = Math.abs(rawInput) >= 1e12 ? Math.trunc(rawInput) : Math.trunc(rawInput * 1000);
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: must be a valid ISO datetime, date-only value, or unix timestamp`);
    }
    return { iso: date.toISOString(), usedExplicitOffset: false };
  }

  const value = rawInput.trim();
  if (!value) {
    throw new Error(`Invalid ${kind}Time: value is required`);
  }

  if (NUMERIC_TIMESTAMP_RE.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid ${kind}Time: must be a valid unix timestamp`);
    }
    const millis = value.length >= 13 ? numeric : numeric * 1000;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: must be a valid unix timestamp`);
    }
    return { iso: date.toISOString(), usedExplicitOffset: false };
  }

  if (EXPLICIT_TIMEZONE_RE.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${kind}Time: "${value}" is not a valid ISO datetime`);
    }
    const explicitOffset = value.match(EXPLICIT_OFFSET_CAPTURE_RE)?.[1]?.toUpperCase() ?? "Z";
    return {
      iso: date.toISOString(),
      usedExplicitOffset: true,
      explicitOffset,
    };
  }

  const dateOnly = parseDateOnly(value);
  if (dateOnly) {
    if (kind === "end") {
      dateOnly.hour = 23;
      dateOnly.minute = 59;
      dateOnly.second = 59;
      dateOnly.millisecond = 999;
    }
    return { iso: buildZonedDate(dateOnly, value, timeZone).toISOString(), usedExplicitOffset: false };
  }

  const naiveDateTime = parseNaiveDateTime(value);
  if (naiveDateTime) {
    return { iso: buildZonedDate(naiveDateTime, value, timeZone).toISOString(), usedExplicitOffset: false };
  }

  throw new Error(
    `Invalid ${kind}Time: use ISO datetime, date-only (YYYY-MM-DD), or unix timestamp`,
  );
}

function normalizeBacktestTimeRange(
  startInput: string | number,
  endInput: string | number,
  timeZoneOverride?: string,
): BacktestNormalizedTimeRange {
  const parsedTimeZoneOverride = resolveBacktestTimeZoneOverride(timeZoneOverride);
  const effectiveTimeZone = parsedTimeZoneOverride ?? resolveRuntimeTimeZone();
  const start = normalizeBacktestTimeInput(startInput, "start", effectiveTimeZone);
  const end = normalizeBacktestTimeInput(endInput, "end", effectiveTimeZone);

  if (new Date(start.iso).getTime() >= new Date(end.iso).getTime()) {
    throw new Error("Invalid backtest time range: startTime must be earlier than endTime");
  }

  const bothExplicitOffsets = start.usedExplicitOffset && end.usedExplicitOffset;
  const sharedExplicitOffset =
    bothExplicitOffsets && start.explicitOffset === end.explicitOffset
      ? start.explicitOffset
      : undefined;
  const usesExplicitTimeZoneParameter = Boolean(parsedTimeZoneOverride);

  return {
    startTime: start.iso,
    endTime: end.iso,
    timeZoneUsed: usesExplicitTimeZoneParameter
      ? parsedTimeZoneOverride!
      : bothExplicitOffsets
        ? sharedExplicitOffset ?? "explicit-input-offset"
        : effectiveTimeZone,
    timeZoneSource: usesExplicitTimeZoneParameter
      ? "explicit-timezone-parameter"
      : bothExplicitOffsets
        ? "explicit-input-offset"
        : "runtime-timezone",
  };
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

async function fetchUsdcBalance(masterWalletAddress: string, chainId: number): Promise<number> {
  const apiUrl = chainId === 999
    ? "https://api.hyperliquid.xyz/info"
    : "https://api.hyperliquid-testnet.xyz/info";

  // Try Standard Account first
  const chRes = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: masterWalletAddress }),
  });
  if (!chRes.ok) throw new Error(`clearinghouseState failed: ${chRes.status}`);
  const chData = await chRes.json();
  const withdrawable = parseFloat(chData.withdrawable ?? "0");
  if (withdrawable > 0) return withdrawable;

  // Try Unified Account (spotClearinghouseState)
  const spotRes = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user: masterWalletAddress }),
  });
  if (!spotRes.ok) throw new Error(`spotClearinghouseState failed: ${spotRes.status}`);
  const spotData = await spotRes.json();

  let balance = 0;
  const tokenAvail = spotData.tokenToAvailableAfterMaintenance;
  if (Array.isArray(tokenAvail)) {
    const usdcEntry = tokenAvail.find((e: any) => e[0] === 0);
    if (usdcEntry) balance = parseFloat(usdcEntry[1]);
  }
  if (balance === 0 && Array.isArray(spotData.balances)) {
    const usdcBal = spotData.balances.find((b: any) => b.coin === "USDC");
    if (usdcBal) balance = parseFloat(usdcBal.total ?? "0");
  }

  return balance;
}

async function deriveDefaultLiveBuyLimit(
  masterWalletAddress: string,
  chainId: number,
  leverage = DEFAULT_LIVE_LEVERAGE,
): Promise<{ initialCapital: number; leverage: number; buyLimit: number } | null> {
  if (chainId !== 998 && chainId !== 999) {
    return null;
  }
  const initialCapital = await fetchUsdcBalance(masterWalletAddress, chainId);
  if (initialCapital === 0) {
    const appUrl = chainId === 999
      ? "https://app.hyperliquid.xyz"
      : "https://app.hyperliquid-testnet.xyz";
    throw new Error(
      `Wallet ${masterWalletAddress} has 0 USDC balance. Deposit USDC before deploying: ${appUrl}`,
    );
  }
  return {
    initialCapital,
    leverage,
    buyLimit: initialCapital * leverage,
  };
}

export default function (api: any) {
  const pluginConfig = api.config?.plugins?.entries?.["trading-plugin"]?.config ?? api.config ?? {};
  const baseUrl: string = pluginConfig.baseUrl ?? DEFAULT_BASE_URL;
  const tradingBotUrl: string = pluginConfig.tradingBotUrl ?? DEFAULT_BOT_URL;
  const backtestEngineUrl: string = pluginConfig.backtestEngineUrl ?? DEFAULT_BACKTEST_ENGINE_URL;
  const walletAgentUrl: string = pluginConfig.walletAgentUrl ?? DEFAULT_WALLET_AGENT_URL;
  const settlementEngineUrl: string = pluginConfig.settlementEngineUrl ?? DEFAULT_SETTLEMENT_ENGINE_URL;
  const billingEvmConfig = buildBillingEvmConfig(pluginConfig);
  const billingProvider = new JsonRpcProvider(billingEvmConfig.rpcUrl);

  // ── Debug logger ───────────────────────────────────────────────
  const debugLogPath = path.join(os.homedir(), ".openclaw", "logs", "trading-debug.json");

  function debugLog(tool: string, step: string, data: unknown) {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      const entry = { ts: new Date().toISOString(), tool, step, data: sanitizeForLog(data) };
      fs.appendFileSync(debugLogPath, JSON.stringify(entry) + "\n");
    } catch {}
  }

  function extractApiData<T = any>(body: any): T {
    return (body?.data ?? body) as T;
  }

  function responseErrorMessage(body: any): string {
    if (typeof body === "string") return body;
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.message === "string") return body.message;
    if (typeof body?.data?.error === "string") return body.data.error;
    if (typeof body?.data?.message === "string") return body.data.message;
    return JSON.stringify(body ?? {});
  }

  function isWalletNotRegisteredError(status: number, body: any): boolean {
    const message = responseErrorMessage(body).toLowerCase();
    return (status === 403 || status === 404) && (
      message.includes("wallet not registered") ||
      message.includes("wallet_address not found") ||
      message.includes("wallet address not found") ||
      message.includes("user not found")
    );
  }

  function resolveMarketType(_mode: string, marketType?: string): "spot" | "perp" {
    return marketType === "perp" ? "perp" : "spot";
  }

  function resolveLiveChainId(chainId?: number): 998 | 999 {
    if (chainId == null) {
      throw new Error("chainId is required for live mode (998=testnet, 999=mainnet)");
    }
    if (chainId !== 998 && chainId !== 999) {
      throw new Error("Invalid chainId for live mode. Use 998 for Hyperliquid testnet or 999 for Hyperliquid mainnet");
    }
    return chainId;
  }

  function hasOwnField<T extends object>(value: T, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function normalizeAddress(value?: string | null): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized ? normalized.toLowerCase() : null;
  }

  function inferSymbolFromStrategy(strategy: unknown): string | undefined {
    if (!strategy || typeof strategy !== "object") return undefined;
    const symbol = (strategy as { symbol?: unknown }).symbol;
    return typeof symbol === "string" && symbol.trim() ? symbol.trim() : undefined;
  }

  function inferAssetTypeFromSymbol(symbol?: string): "crypto" | "stocks" | undefined {
    if (!symbol) return undefined;
    return SUPPORTED_PAIRS.find((pair) => pair.symbol === symbol)?.asset_type;
  }

  function normalizeSimulationProtocol(protocol?: string): string | undefined {
    if (!protocol) return undefined;
    return protocol.toLowerCase() === "hyperliquid" ? "hyperliquid" : "uniswap";
  }

  function inferLiveProtocol(input: {
    protocol?: string;
    marketType?: "spot" | "perp";
    chainId?: number | null;
    walletNetwork?: string | null;
  }): string | undefined {
    if (input.protocol) return input.protocol;
    if (input.walletNetwork === "mainnet" || input.walletNetwork === "testnet") {
      return "hyperliquid";
    }
    if (input.chainId === 998 || input.chainId === 999) {
      return "hyperliquid";
    }
    if (input.marketType === "perp") {
      return "hyperliquid";
    }
    return undefined;
  }

  function buildDerivedSimulationConfig(input: {
    symbol?: string;
    marketType: "spot" | "perp";
    chainId?: number | null;
    protocol?: string;
    patch?: {
      asset_type?: string;
      protocol?: string;
      chain_id?: number;
    };
  }): Record<string, unknown> {
    const explicitAssetType = input.patch?.asset_type;
    const inferredAssetType = explicitAssetType ?? inferAssetTypeFromSymbol(input.symbol) ?? "crypto";
    if (inferredAssetType === "stocks") {
      return { asset_type: "stocks" };
    }

    const protocol = normalizeSimulationProtocol(
      input.patch?.protocol ?? input.protocol ?? (input.marketType === "perp" ? "hyperliquid" : undefined),
    ) ?? (input.marketType === "perp" ? "hyperliquid" : "uniswap");

    let chainId = input.patch?.chain_id ?? input.chainId ?? null;
    if (protocol === "hyperliquid") {
      chainId = chainId === 999 ? 999 : 998;
    } else if (chainId == null || chainId === 998 || chainId === 999) {
      chainId = 1;
    }

    return {
      asset_type: "crypto",
      protocol,
      chain_id: chainId,
    };
  }

  function resolveWalletRecord(
    wallets: any[],
    input: { walletId?: number | null; walletAddress?: string | null },
  ): any | undefined {
    const normalizedWalletAddress = normalizeAddress(input.walletAddress);
    return wallets.find((wallet) => {
      if (input.walletId != null && Number(wallet.id) === input.walletId) {
        return true;
      }
      if (normalizedWalletAddress && typeof wallet.wallet_address === "string") {
        return wallet.wallet_address.toLowerCase() === normalizedWalletAddress;
      }
      return false;
    });
  }

  async function parseResponseBody(res: Response): Promise<any> {
    return await res.json().catch(async () => await res.text().catch(() => null));
  }

  async function fetchAgentSettingsForUpdate(auth: string, agentId: number): Promise<any> {
    const res = await fetch(`${baseUrl}/api/agent/settings/${agentId}`, {
      headers: { Authorization: auth },
    });
    const body = await parseResponseBody(res);
    if (!res.ok) {
      throw new Error(`get_agent_settings failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    return extractApiData(body);
  }

  async function fetchWalletsForUpdate(auth: string): Promise<any[]> {
    const res = await fetch(`${baseUrl}/api/wallets?includeAuthorizedAgents=true`, {
      headers: { Authorization: auth },
    });
    const body = await parseResponseBody(res);
    if (!res.ok) {
      throw new Error(`list_wallets failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    const data = extractApiData<any[]>(body);
    return Array.isArray(data) ? data : [];
  }

  function buildAgentActionSignature(
    privateKey: string,
    publicKey: string,
    agentId: number,
    action: string,
    timestamp: number,
  ): string {
    return Signer.getSignature(
      {
        agent_id: agentId,
        action,
        user: Nip19.npubEncode(publicKey),
        timestamp,
      },
      privateKey,
      {
        agent_id: "number",
        action: "string",
        user: "string",
        timestamp: "number",
      } as const,
    );
  }

  function buildWalletActionSignature(
    privateKey: string,
    publicKey: string,
    walletAddress: string,
    action: string,
    createdAt: number,
    agentId?: number,
  ): string {
    const payload: Record<string, unknown> = {
      created_at: createdAt,
      wallet_address: walletAddress,
      action,
      npub: Nip19.npubEncode(publicKey),
    };
    const schema: Record<string, "string" | "number"> = {
      created_at: "number",
      wallet_address: "string",
      action: "string",
      npub: "string",
    };
    if (agentId != null) {
      payload.agent_id = agentId;
      schema.agent_id = "number";
    }
    return Signer.getSignature(payload, privateKey, schema);
  }

  async function fetchPublicAgentProfile(agentId: number): Promise<any> {
    const res = await fetch(`${baseUrl}/api/agent/${agentId}`);
    const body = await parseResponseBody(res);
    if (!res.ok) {
      throw new Error(`get_agent failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    return extractApiData(body);
  }

  async function fetchSettlementProtocolName(
    marketType: "spot" | "perp",
    chainId: number,
  ): Promise<string | undefined> {
    const res = await fetch(`${settlementEngineUrl}/instruments/${marketType}`);
    const body = await parseResponseBody(res);
    if (!res.ok) {
      throw new Error(`settlement instruments failed: ${res.status} ${responseErrorMessage(body)}`);
    }

    const instruments = Array.isArray(body?.instruments)
      ? body.instruments
      : Array.isArray(body?.data?.instruments)
        ? body.data.instruments
        : [];
    const match = instruments.find((instrument: any) => Number(instrument?.chain_id) === chainId);
    const protocolName = match?.protocol_name;
    return typeof protocolName === "string" && protocolName.trim()
      ? protocolName.trim()
      : undefined;
  }

  function buildBillingWallet(): Wallet {
    const privateKey = pluginConfig.nostrPrivateKey;
    if (!privateKey) {
      throw new Error("nostrPrivateKey is required for billing wallet access");
    }
    return new Wallet(normalizeHexPrivateKey(privateKey), billingProvider);
  }

  async function buildBillingHeaders(wallet: Wallet): Promise<EthHeaders> {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = makeBillingAccessMessage(wallet.address, timestamp);
    const signature = await wallet.signMessage(message);
    return {
      "x-eth-message": message,
      "x-eth-signature": signature,
    };
  }

  async function billingFetch(
    url: string,
    wallet: Wallet,
    options?: RequestInit,
  ): Promise<{ res: Response; body: any }> {
    const billingHeaders = await buildBillingHeaders(wallet);
    const optionHeaders = options?.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : Array.isArray(options?.headers)
        ? Object.fromEntries(options.headers)
        : { ...((options?.headers as Record<string, string> | undefined) ?? {}) };
    const headers: Record<string, string> = {
      ...optionHeaders,
      ...billingHeaders,
    };
    const res = await fetch(url, { ...options, headers });
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    return { res, body };
  }

  async function ensureBillingWalletRegistered(input: {
    npub: string;
    publicKey: string;
    privateKey: string;
    wallet: Wallet;
  }): Promise<{ walletAddress: string; inserted: boolean }> {
    const url = `${baseUrl}/api/auth/login`;
    const timestamp = Math.floor(Date.now() / 1000);
    const ethMessage = makeBillingWalletLoginMessage(input.npub, timestamp);
    const ethSignature = await input.wallet.signMessage(ethMessage);
    const authorization = getAuthHeader(input.publicKey, input.privateKey);

    debugLog("billing", "api.req /api/auth/login", {
      url,
      npub: input.npub,
      walletAddress: input.wallet.address,
      authorization,
      "x-eth-message": ethMessage,
      "x-eth-signature": ethSignature,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "x-eth-message": ethMessage,
        "x-eth-signature": ethSignature,
      },
    });
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    debugLog("billing", "api.res /api/auth/login", {
      status: res.status,
      body,
      npub: input.npub,
      walletAddress: input.wallet.address,
    });
    if (!res.ok) {
      throw new Error(`auth/login failed: ${res.status} ${responseErrorMessage(body)}`);
    }

    const data = extractApiData<any>(body) ?? {};
    const registeredWalletAddress = data.walletAddress
      ? getAddress(String(data.walletAddress))
      : input.wallet.address;
    if (registeredWalletAddress.toLowerCase() !== input.wallet.address.toLowerCase()) {
      throw new Error(
        `auth/login returned billing wallet ${registeredWalletAddress}, expected ${input.wallet.address}`,
      );
    }

    return {
      walletAddress: registeredWalletAddress,
      inserted: Boolean(data.inserted),
    };
  }

  async function fetchBillingBypassStatus(npub: string): Promise<boolean> {
    const url = `${baseUrl}/api/is-whitelisted/${npub}`;
    debugLog("billing", "api.req billing-bypass-status", { url, npub });
    const res = await fetch(url);
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    debugLog("billing", "api.res billing-bypass-status", { status: res.status, body });
    if (!res.ok) {
      throw new Error(`billing bypass check failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    return Boolean(extractApiData(body)?.isWhitelisted);
  }

  async function fetchEligibleNftConfigs(): Promise<EligibleNftConfig[]> {
    const url = `${baseUrl}/api/nft-config`;
    debugLog("billing", "api.req /api/nft-config", { url });
    const res = await fetch(url);
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    debugLog("billing", "api.res /api/nft-config", { status: res.status, body });
    if (!res.ok) {
      throw new Error(`nft-config failed: ${res.status} ${responseErrorMessage(body)}`);
    }

    const data = extractApiData<any>(body);
    if (!Array.isArray(data)) {
      throw new Error("nft-config returned invalid payload");
    }

    const activeConfigs = data.filter((item) => isActiveNftConfig(item?.is_active));
    if (activeConfigs.length === 0) {
      throw new Error("nft-config returned no usable active NFT configs");
    }

    const parsed = activeConfigs.map((item, index) => {
      const entryId = item?.id == null ? String(index + 1) : String(item.id);
      const rawAddress = typeof item?.address === "string" ? item.address : "";
      const rawName = typeof item?.nft_name === "string" ? item.nft_name.trim() : "";
      const rawMinimumStake = item?.minimum_stake;
      const rawProtocolFee = item?.protocol_fee;

      if (!rawAddress) {
        throw new Error(`nft-config active entry ${entryId} is missing address`);
      }
      if (rawMinimumStake == null) {
        throw new Error(`nft-config active entry ${entryId} is missing minimum_stake`);
      }
      if (rawProtocolFee == null) {
        throw new Error(`nft-config active entry ${entryId} is missing protocol_fee`);
      }

      let contractAddress: string;
      let minimumStakeRaw: bigint;
      let protocolFeeRaw: bigint;
      try {
        contractAddress = getAddress(rawAddress);
      } catch {
        throw new Error(`nft-config active entry ${entryId} has invalid address: ${rawAddress}`);
      }
      try {
        minimumStakeRaw = parseTokenAmount(rawMinimumStake, billingEvmConfig.tokenDecimals);
      } catch {
        throw new Error(`nft-config active entry ${entryId} has invalid minimum_stake: ${rawMinimumStake}`);
      }
      try {
        protocolFeeRaw = parseTokenAmount(rawProtocolFee, billingEvmConfig.tokenDecimals);
      } catch {
        throw new Error(`nft-config active entry ${entryId} has invalid protocol_fee: ${rawProtocolFee}`);
      }

      const totalMintingFeeRaw = minimumStakeRaw + protocolFeeRaw;
      const name = rawName || `${DEFAULT_ELIGIBLE_NFT_NAME} ${entryId}`;
      return {
        id: entryId,
        name,
        contractAddress,
        explorerUrl: buildExplorerUrl(
          billingEvmConfig.eligibleNftExplorerUrl,
          billingEvmConfig.eligibleNftAddress,
          contractAddress,
        ),
        minimumStakeRaw,
        protocolFeeRaw,
        totalMintingFeeRaw,
        minimumStake: formatAmount(minimumStakeRaw, billingEvmConfig.tokenDecimals),
        protocolFee: formatAmount(protocolFeeRaw, billingEvmConfig.tokenDecimals),
        totalMintingFee: formatAmount(totalMintingFeeRaw, billingEvmConfig.tokenDecimals),
        sortIndex: index,
      };
    });

    parsed.sort((a, b) => {
      if (a.totalMintingFeeRaw !== b.totalMintingFeeRaw) {
        return a.totalMintingFeeRaw < b.totalMintingFeeRaw ? -1 : 1;
      }
      if (a.minimumStakeRaw !== b.minimumStakeRaw) {
        return a.minimumStakeRaw < b.minimumStakeRaw ? -1 : 1;
      }
      return a.sortIndex - b.sortIndex;
    });

    return parsed;
  }

  async function fetchBillingFeeQuote(agentId?: number): Promise<{
    periodSeconds: number;
    operatingFeeRaw: bigint;
    protocolFeeRaw: bigint;
    strategyFeeRaw: bigint;
    tokenSymbol: string;
  }> {
    const query = agentId != null ? `?agentId=${encodeURIComponent(String(agentId))}` : "";
    const url = `${baseUrl}/api/billing-fee${query}`;
    debugLog("billing", "api.req /api/billing-fee", { url });
    const res = await fetch(url);
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    debugLog("billing", "api.res /api/billing-fee", { status: res.status, body });
    if (!res.ok) {
      throw new Error(`billing-fee failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    const data = extractApiData<any>(body) ?? {};
    return {
      periodSeconds: Number(data.period ?? 2_592_000),
      operatingFeeRaw: parseTokenAmount(data.operating_fee_per_period ?? 0, billingEvmConfig.tokenDecimals),
      protocolFeeRaw: parseTokenAmount(data.protocol_fee_per_period ?? 0, billingEvmConfig.tokenDecimals),
      strategyFeeRaw: parseTokenAmount(data.strategy_fee_per_period ?? 0, billingEvmConfig.tokenDecimals),
      tokenSymbol: data.token_symbol ?? billingEvmConfig.tokenSymbol,
    };
  }

  async function fetchBillingBalanceSnapshot(wallet: Wallet): Promise<{
    availableBalanceRaw: bigint;
    pendingWithdrawalBalanceRaw: bigint;
    walletRegistered: boolean;
  }> {
    const url = `${baseUrl}/api/balance`;
    debugLog("billing", "api.req /api/balance", { url, walletAddress: wallet.address });
    const { res, body } = await billingFetch(url, wallet);
    debugLog("billing", "api.res /api/balance", { status: res.status, body, walletAddress: wallet.address });
    if (isWalletNotRegisteredError(res.status, body)) {
      return {
        availableBalanceRaw: 0n,
        pendingWithdrawalBalanceRaw: 0n,
        walletRegistered: false,
      };
    }
    if (!res.ok) {
      throw new Error(`billing balance failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    const data = extractApiData<any>(body) ?? {};
    return {
      availableBalanceRaw: parseTokenAmount(data.available_balance ?? 0, billingEvmConfig.tokenDecimals),
      pendingWithdrawalBalanceRaw: parseTokenAmount(data.pending_withdrawal_balance ?? 0, billingEvmConfig.tokenDecimals),
      walletRegistered: true,
    };
  }

  async function fetchBillingSubscriptions(wallet: Wallet): Promise<any[]> {
    const snapshot = await fetchBillingSubscriptionsSnapshot(wallet);
    return snapshot.subscriptions;
  }

  async function fetchBillingSubscriptionsSnapshot(wallet: Wallet): Promise<{
    subscriptions: any[];
    walletRegistered: boolean;
  }> {
    const url = `${baseUrl}/api/billing-subscriptions`;
    debugLog("billing", "api.req /api/billing-subscriptions", { url, walletAddress: wallet.address });
    const { res, body } = await billingFetch(url, wallet);
    debugLog("billing", "api.res /api/billing-subscriptions", { status: res.status, body, walletAddress: wallet.address });
    if (isWalletNotRegisteredError(res.status, body)) {
      return {
        subscriptions: [],
        walletRegistered: false,
      };
    }
    if (!res.ok) {
      throw new Error(`billing-subscriptions failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    const data = extractApiData<any>(body);
    return {
      subscriptions: Array.isArray(data) ? data : [],
      walletRegistered: true,
    };
  }

  async function prepareAgentCreationContext(input: {
    name: string;
    mode?: string;
    marketType?: string;
    symbol?: string;
    agentId?: number;
    npub: string;
    publicKey: string;
    privateKey: string;
  }): Promise<PreparedAgentCreationContext> {
    const mode = input.mode ?? "paper";
    const marketType = resolveMarketType(mode, input.marketType);

    const billingBypassed = await fetchBillingBypassStatus(input.npub);
    if (billingBypassed) {
      const billingWallet = buildBillingWallet();
      return {
        prepared: {
          identity: {
            npub: input.npub,
            publicKey: input.publicKey,
          },
          billing: {
            required: false,
            bypassed: true,
            canSkipNftPurchase: true,
          },
          wallet: {
            address: billingWallet.address,
            networkLabel: billingEvmConfig.networkLabel,
            usesNostrPrivateKey: true,
          },
          nft: {
            required: false,
            hasEligibleNft: false,
            eligibleOptions: [],
          },
          fees: {
            operatingFee: "0",
            protocolFee: "0",
            strategyFee: "0",
            firstBillingAmount: "0",
            existingVaultCredit: "0",
            targetVaultCredit: "0",
            oswapForNft: "0",
            oswapForInitialVaultCredit: "0",
            requiredOswap: "0",
            oswapShortfall: "0",
            note: "No upfront billing setup is required for this account.",
          },
          executionPlan: {
            agentName: input.name,
            mode,
            marketType,
            symbol: input.symbol ?? null,
            actions: [`Create ${mode} ${marketType} agent directly.`],
            approvals: [],
            depositToVault: "0",
          },
        },
        billingWallet,
        operatingFeeRaw: 0n,
        protocolFeeRaw: 0n,
        strategyFeeRaw: 0n,
        firstBillingAmountRaw: 0n,
        existingVaultCreditRaw: 0n,
        targetVaultCreditRaw: 0n,
        oswapForNftRaw: 0n,
        oswapForInitialVaultCreditRaw: 0n,
        requiredOswapRaw: 0n,
        oswapShortfallRaw: 0n,
        walletOswapBalanceRaw: 0n,
        walletBnbBalanceRaw: 0n,
        bnbForSwapQuotedRaw: 0n,
        bnbForSwapMaxRaw: 0n,
        bnbForGasRaw: 0n,
        totalBnbNeededRaw: 0n,
        bnbShortfallRaw: 0n,
        gasPriceWei: 0n,
        hasEligibleNft: false,
        nftApprovalRequired: false,
        vaultApprovalRequired: false,
        billingPeriodSeconds: 2_592_000,
        selectedEligibleNft: undefined,
        ownedEligibleNft: undefined,
      };
    }

    const eligibleNftConfigs = await fetchEligibleNftConfigs();
    const selectedEligibleNft = eligibleNftConfigs[0];
    const billingWallet = buildBillingWallet();
    await ensureBillingWalletRegistered({
      npub: input.npub,
      publicKey: input.publicKey,
      privateKey: input.privateKey,
      wallet: billingWallet,
    });
    const provider = billingWallet.provider as JsonRpcProvider;
    const tokenRead = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, provider) as any;
    const nftReads = eligibleNftConfigs.map((config) => new Contract(config.contractAddress, NFT_ABI, provider) as any);
    const routerRead = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, provider) as any;
    const tokenWrite = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, billingWallet) as any;
    const nftWrite = new Contract(selectedEligibleNft.contractAddress, NFT_ABI, billingWallet) as any;
    const vaultWrite = new Contract(billingEvmConfig.vaultAddress, VAULT_ABI, billingWallet) as any;
    const routerWrite = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, billingWallet) as any;
    const [feeQuote, billingBalance, rawOswapBalance, rawBnbBalance, rawNftBalances, rawNftAllowance, rawVaultAllowance, feeData] = await Promise.all([
      fetchBillingFeeQuote(input.agentId),
      fetchBillingBalanceSnapshot(billingWallet),
      tokenRead.balanceOf(billingWallet.address),
      provider.getBalance(billingWallet.address),
      Promise.all(nftReads.map((contract) => contract.balanceOf(billingWallet.address))),
      tokenRead.allowance(billingWallet.address, selectedEligibleNft.contractAddress),
      tokenRead.allowance(billingWallet.address, billingEvmConfig.vaultAddress),
      provider.getFeeData(),
    ]);

    const operatingFeeRaw: bigint = feeQuote.operatingFeeRaw;
    const protocolFeeRaw: bigint = feeQuote.protocolFeeRaw;
    const strategyFeeRaw: bigint = feeQuote.strategyFeeRaw;
    const firstBillingAmountRaw: bigint = operatingFeeRaw + protocolFeeRaw + strategyFeeRaw;
    const targetVaultCreditRaw: bigint = firstBillingAmountRaw;

    const walletOswapBalanceRaw = BigInt(rawOswapBalance.toString());
    const walletBnbBalanceRaw = BigInt(rawBnbBalance.toString());
    const ownedEligibleNft = eligibleNftConfigs.find((_, index) => BigInt(rawNftBalances[index].toString()) > 0n);
    const hasEligibleNft = ownedEligibleNft != null;
    const existingVaultCreditRaw: bigint = billingBalance.availableBalanceRaw;
    const oswapForNftRaw: bigint = hasEligibleNft
      ? 0n
      : selectedEligibleNft.totalMintingFeeRaw;
    const oswapForInitialVaultCreditRaw: bigint = targetVaultCreditRaw > existingVaultCreditRaw
      ? targetVaultCreditRaw - existingVaultCreditRaw
      : 0n;
    const requiredOswapRaw: bigint = oswapForNftRaw + oswapForInitialVaultCreditRaw;
    const oswapShortfallRaw = maxBigInt(0n, requiredOswapRaw - walletOswapBalanceRaw);
    const nftApprovalRequired = oswapForNftRaw > 0n && BigInt(rawNftAllowance.toString()) < oswapForNftRaw;
    const vaultApprovalRequired = oswapForInitialVaultCreditRaw > 0n && BigInt(rawVaultAllowance.toString()) < oswapForInitialVaultCreditRaw;

    let bnbForSwapQuotedRaw = 0n;
    let bnbForSwapMaxRaw = 0n;
    const swapPath = [billingEvmConfig.wethAddress, billingEvmConfig.tokenAddress];
    if (oswapShortfallRaw > 0n) {
      const amountsIn = await routerRead.getAmountsIn(oswapShortfallRaw, swapPath);
      bnbForSwapQuotedRaw = BigInt(amountsIn[0].toString());
      bnbForSwapMaxRaw = computeAmountInMax(bnbForSwapQuotedRaw, billingEvmConfig.swapSlippageBps);
    }

    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 5_000_000_000n;
    const renewalPeriodDays = Math.round(feeQuote.periodSeconds / 86_400);
    const estimatedEndTime = new Date(Date.now() + feeQuote.periodSeconds * 1_000).toISOString();
    const swapDeadline = Math.floor(Date.now() / 1000) + 1_200;
    const gas = {
      swap: await estimateStepCost(
        () => routerWrite.swapETHForExactTokens.estimateGas(
          oswapShortfallRaw,
          swapPath,
          billingWallet.address,
          swapDeadline,
          { value: bnbForSwapMaxRaw },
        ),
        gasPriceWei,
        DEFAULT_FALLBACK_SWAP_GAS,
        oswapShortfallRaw > 0n,
      ),
      nftApproval: await estimateStepCost(
        () => tokenWrite.approve.estimateGas(selectedEligibleNft.contractAddress, oswapForNftRaw),
        gasPriceWei,
        DEFAULT_FALLBACK_APPROVE_GAS,
        nftApprovalRequired,
      ),
      nftMint: await estimateStepCost(
        () => nftWrite.stake.estimateGas(oswapForNftRaw),
        gasPriceWei,
        DEFAULT_FALLBACK_NFT_STAKE_GAS,
        oswapForNftRaw > 0n,
      ),
      vaultApproval: await estimateStepCost(
        () => tokenWrite.approve.estimateGas(billingEvmConfig.vaultAddress, oswapForInitialVaultCreditRaw),
        gasPriceWei,
        DEFAULT_FALLBACK_APPROVE_GAS,
        vaultApprovalRequired,
      ),
      vaultDeposit: await estimateStepCost(
        () => vaultWrite.deposit.estimateGas(billingWallet.address, oswapForInitialVaultCreditRaw),
        gasPriceWei,
        DEFAULT_FALLBACK_VAULT_DEPOSIT_GAS,
        oswapForInitialVaultCreditRaw > 0n,
      ),
    };

    const bnbForGasRaw =
      (BigInt(gas.swap.gasUnits) +
        BigInt(gas.nftApproval.gasUnits) +
        BigInt(gas.nftMint.gasUnits) +
        BigInt(gas.vaultApproval.gasUnits) +
        BigInt(gas.vaultDeposit.gasUnits)) * gasPriceWei;
    const totalBnbNeededRaw = bnbForSwapMaxRaw + bnbForGasRaw;
    const bnbShortfallRaw = maxBigInt(0n, totalBnbNeededRaw - walletBnbBalanceRaw);

    const actions: string[] = [];
    if (hasEligibleNft) {
      actions.push(`Use existing eligible ${ownedEligibleNft!.name}.`);
    } else {
      actions.push(`Mint cheapest eligible NFT ${selectedEligibleNft.name} by staking ${formatAmount(oswapForNftRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol}.`);
    }
    if (oswapShortfallRaw > 0n) {
      actions.unshift(
        `Swap up to ${formatAmount(bnbForSwapMaxRaw, 18, 8)} BNB for ${formatAmount(oswapShortfallRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol}.`,
      );
    }
    if (oswapForInitialVaultCreditRaw > 0n) {
      actions.push(
        `Deposit ${formatAmount(oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} into the billing vault.`,
      );
    } else {
      actions.push(`Use existing vault credit of ${formatAmount(existingVaultCreditRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol}.`);
    }
    actions.push(
      `Create ${mode} ${marketType} agent "${input.name}"${input.symbol ? ` for ${input.symbol}` : ""}.`,
    );

    const approvals: string[] = [];
    if (nftApprovalRequired) {
      approvals.push(
        `Approve ${formatAmount(oswapForNftRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} for NFT contract ${selectedEligibleNft.contractAddress}.`,
      );
    }
    if (vaultApprovalRequired) {
      approvals.push(
        `Approve ${formatAmount(oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} for vault ${billingEvmConfig.vaultAddress}.`,
      );
    }

    const prepared: PreparedAgentCreationResult = {
      identity: {
        npub: input.npub,
        publicKey: input.publicKey,
      },
      billing: {
        required: true,
        bypassed: false,
        canSkipNftPurchase: hasEligibleNft,
      },
      wallet: {
        address: billingWallet.address,
        oswapBalance: formatAmount(walletOswapBalanceRaw, billingEvmConfig.tokenDecimals),
        bnbBalance: formatAmount(walletBnbBalanceRaw, 18, 8),
        networkLabel: billingEvmConfig.networkLabel,
        usesNostrPrivateKey: true,
      },
      nft: {
        required: !hasEligibleNft,
        hasEligibleNft,
        eligibleOptions: eligibleNftConfigs.map((config) => ({
          name: config.name,
          contractAddress: config.contractAddress,
          explorerUrl: config.explorerUrl,
          minimumStake: config.minimumStake,
          protocolFee: config.protocolFee,
          totalMintingFee: config.totalMintingFee,
        })),
      },
      fees: {
        operatingFee: formatAmount(operatingFeeRaw, billingEvmConfig.tokenDecimals),
        protocolFee: formatAmount(protocolFeeRaw, billingEvmConfig.tokenDecimals),
        strategyFee: formatAmount(strategyFeeRaw, billingEvmConfig.tokenDecimals),
        firstBillingAmount: formatAmount(firstBillingAmountRaw, billingEvmConfig.tokenDecimals),
        existingVaultCredit: formatAmount(existingVaultCreditRaw, billingEvmConfig.tokenDecimals),
        targetVaultCredit: formatAmount(targetVaultCreditRaw, billingEvmConfig.tokenDecimals),
        oswapForNft: formatAmount(oswapForNftRaw, billingEvmConfig.tokenDecimals),
        oswapForInitialVaultCredit: formatAmount(oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
        requiredOswap: formatAmount(requiredOswapRaw, billingEvmConfig.tokenDecimals),
        oswapShortfall: formatAmount(oswapShortfallRaw, billingEvmConfig.tokenDecimals),
        note: `Vault deposits become billable ${feeQuote.tokenSymbol} credit. The initial deposit target equals the first billing amount: ${formatAmount(firstBillingAmountRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} every ${renewalPeriodDays} days.`,
      },
      subscription: {
        estimatedEndTime,
        renewalPeriodDays,
        renewalAmount: formatAmount(firstBillingAmountRaw, billingEvmConfig.tokenDecimals),
      },
      funding: {
        bnbForSwapQuoted: formatAmount(bnbForSwapQuotedRaw, 18, 8),
        bnbForSwapMax: formatAmount(bnbForSwapMaxRaw, 18, 8),
        bnbForGas: formatAmount(bnbForGasRaw, 18, 8),
        totalBnbNeeded: formatAmount(totalBnbNeededRaw, 18, 8),
        bnbShortfall: formatAmount(bnbShortfallRaw, 18, 8),
      },
      approvals: {
        nftApprovalRequired,
        vaultApprovalRequired,
      },
      gas: {
        gasPriceWei: gasPriceWei.toString(),
        gasPriceGwei: formatAmount(gasPriceWei, 9, 4),
        steps: gas,
      },
      executionPlan: {
        agentName: input.name,
        mode,
        marketType,
        symbol: input.symbol ?? null,
        actions,
        approvals,
        depositToVault: formatAmount(oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals),
      },
    };

    const context: PreparedAgentCreationContext = {
      prepared,
      billingWallet,
      operatingFeeRaw,
      protocolFeeRaw,
      strategyFeeRaw,
      firstBillingAmountRaw,
      existingVaultCreditRaw,
      targetVaultCreditRaw,
      oswapForNftRaw,
      oswapForInitialVaultCreditRaw,
      requiredOswapRaw,
      oswapShortfallRaw,
      walletOswapBalanceRaw,
      walletBnbBalanceRaw,
      bnbForSwapQuotedRaw,
      bnbForSwapMaxRaw,
      bnbForGasRaw,
      totalBnbNeededRaw,
      bnbShortfallRaw,
      gasPriceWei,
      hasEligibleNft,
      nftApprovalRequired,
      vaultApprovalRequired,
      billingPeriodSeconds: feeQuote.periodSeconds,
      selectedEligibleNft,
      ownedEligibleNft,
    };
    debugLog("prepare_agent_creation", "result", context.prepared);
    return context;
  }

  async function waitForVaultCredit(wallet: Wallet, minimumAvailableBalanceRaw: bigint): Promise<{
    availableBalanceRaw: bigint;
    pendingWithdrawalBalanceRaw: bigint;
    walletRegistered: boolean;
  }> {
    const deadline = Date.now() + billingEvmConfig.balancePollTimeoutMs;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      try {
        const snapshot = await fetchBillingBalanceSnapshot(wallet);
        if (snapshot.availableBalanceRaw >= minimumAvailableBalanceRaw) {
          return snapshot;
        }
      } catch (err: any) {
        lastError = err?.message;
      }
      await sleep(billingEvmConfig.balancePollIntervalMs);
    }
    throw new Error(
      lastError
        ? `Vault deposit was not indexed before timeout: ${lastError}`
        : `Vault deposit was not indexed within ${billingEvmConfig.balancePollTimeoutMs}ms`,
    );
  }

  // ── Existing tools ──────────────────────────────────────────────

  api.registerTool({
    name: "get_token_prices",
    description: "Get current live prices of all tokens",
    parameters: Type.Object({}),
    async execute() {
      const res = await fetch(`${baseUrl}/api/token-prices`);
      if (!res.ok) throw new Error(`token-prices failed: ${res.status}`);
      return textResult(await res.json());
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
      let results = SUPPORTED_PAIRS;

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
    description: "Update a trading agent across the supported backends. Only explicitly provided fields are updated.",
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
      const botDirectFieldKeys = [
        "name",
        "avatarUrl",
        "strategy",
        "strategyDescription",
        "isActive",
        "mode",
        "marketType",
        "leverage",
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

      if (hasOwnField(params, "mode")) {
        warnings.push("mode is only updateable on the trading-bot; trading-data will continue to report the existing mode.");
      }
      if (hasOwnField(params, "marketType")) {
        warnings.push("marketType is not updateable via trading-data. For live agents the settlement trader is recreated because the settlement PATCH API does not support market_type.");
      }
      const dataApiLimitedFields = [
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
      if (dataApiLimitedFields.length > 0) {
        warnings.push(`trading-data does not persist these update fields: ${dataApiLimitedFields.join(", ")}`);
      }
      if (hasOwnField(params, "simulationConfig")) {
        warnings.push("simulationConfig is only updateable on the trading-bot.");
      }
      if (hasOwnField(params, "walletId")) {
        warnings.push("walletId is used only to resolve walletAddress/masterWalletAddress for supported runtime backends; there is no direct walletId update endpoint for agents.");
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
      if (mainUpdateRequested) {
        const tradingDataResult: Record<string, unknown> = {};
        let billingHeaders: Record<string, string> = {};
        let billingRequirement: UpdateAgentBillingRequirement = "unknown";
        let billingError: string | null = null;

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
        };
        if (hasOwnField(params, "name")) body.name = params.name;
        if (hasOwnField(params, "description")) body.description = params.description;
        if (hasOwnField(params, "avatarUrl")) body.avatarUrl = params.avatarUrl;
        if (hasOwnField(params, "strategy")) body.strategy = params.strategy;
        if (hasOwnField(params, "strategyDescription")) body.strategyDescription = params.strategyDescription;
        if (hasOwnField(params, "isActive")) body.isActive = params.isActive;
        if (hasOwnField(params, "leverage")) body.leverage = params.leverage;
        if (hasOwnField(params, "strategyFeePerPeriod")) body.strategyFeePerPeriod = params.strategyFeePerPeriod;

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
      } else {
        result.tradingData = { skipped: true };
      }

      const botNeedsUpdate =
        botDirectFieldKeys.some((field) => hasOwnField(params, field)) ||
        settlementConfigPayload != null ||
        simulationConfigPayload != null;
      if (botNeedsUpdate) {
        const botBody: Record<string, unknown> = {
          signed_at: signedAt,
        };
        if (hasOwnField(params, "name")) botBody.name = params.name;
        if (hasOwnField(params, "avatarUrl")) botBody.avatar_url = params.avatarUrl;
        if (hasOwnField(params, "strategy")) botBody.strategy_config = params.strategy;
        if (hasOwnField(params, "strategyDescription")) botBody.description = params.strategyDescription;
        if (hasOwnField(params, "mode")) botBody.mode = targetMode;
        if (hasOwnField(params, "isActive")) botBody.active = params.isActive;
        if (hasOwnField(params, "marketType")) botBody.market_type = targetMarketType;
        if (hasOwnField(params, "leverage")) botBody.leverage = params.leverage;
        if (settlementConfigPayload) botBody.settlement_config = JSON.stringify(settlementConfigPayload);
        if (simulationConfigPayload) botBody.simulation_config = simulationConfigPayload;

        const botSignature = Signer.getSignature(
          {
            agent_id: params.agentId,
            signed_at: signedAt,
          },
          privateKey,
          {
            agent_id: "number",
            signed_at: "number",
          } as const,
        );

        debugLog("update_agent", "trading-bot.req", { url: `${tradingBotUrl}/agents/${params.agentId}`, body: botBody });
        const res = await fetch(`${tradingBotUrl}/agents/${params.agentId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-public-key": publicKey,
            "x-signature": botSignature,
          },
          body: JSON.stringify(botBody),
        });
        const responseBody = await parseResponseBody(res);
        const ok = res.ok && responseBody?.success !== false;
        result.tradingBot = {
          ok,
          status: res.status,
          body: responseBody,
        };
        debugLog("update_agent", "trading-bot.res", result.tradingBot);
      } else {
        result.tradingBot = { skipped: true };
      }

      const currentIsLive = currentMode === "live";
      const targetIsLive = targetMode === "live";
      const marketTypeChanged = targetMarketType !== currentMarketType;
      const masterWalletChanged =
        targetIsLive &&
        normalizeAddress(resolvedMasterWalletAddress) !== normalizeAddress(currentMasterWalletAddress) &&
        (hasOwnField(params, "masterWalletAddress") || hasOwnField(params, "walletId"));
      const agentAddressChanged =
        targetIsLive &&
        normalizeAddress(resolvedWalletAddress) !== normalizeAddress(currentWalletAddress) &&
        (hasOwnField(params, "walletAddress") || hasOwnField(params, "walletId"));

      const settlementCreateNeeded = !currentIsLive && targetIsLive;
      const settlementDeleteNeeded = currentIsLive && !targetIsLive;
      const settlementRecreateNeeded = currentIsLive && targetIsLive && (marketTypeChanged || masterWalletChanged);
      const settlementPatchNeeded =
        currentIsLive &&
        targetIsLive &&
        !settlementRecreateNeeded &&
        (
          agentAddressChanged ||
          hasOwnField(params, "symbol") ||
          hasOwnField(params, "chainId") ||
          hasOwnField(params, "protocol") ||
          hasOwnField(params, "buyLimit") ||
          hasOwnField(params, "positionQty") ||
          hasOwnField(params, "slippage") ||
          hasOwnField(params, "expiration") ||
          hasOwnField(params, "leverage") ||
          hasOwnField(params, "isActive")
        );

      const settlementActionNeeded =
        settlementCreateNeeded ||
        settlementDeleteNeeded ||
        settlementRecreateNeeded ||
        settlementPatchNeeded;

      if (!settlementActionNeeded) {
        result.settlement = { skipped: true };
        if (settlementConfigFieldKeys.some((field) => hasOwnField(params, field)) && !targetIsLive) {
          warnings.push("Requested live settlement fields were applied only to the trading-bot because the agent remains in paper mode.");
        }
      } else {
        const settlementResult: Record<string, any> = {
          skipped: false,
          action: settlementRecreateNeeded
            ? "recreate"
            : settlementCreateNeeded
              ? "create"
              : settlementDeleteNeeded
                ? "delete"
                : "patch",
          ok: true,
          steps: [] as Array<Record<string, unknown>>,
        };
        const settlementDeleteSignature = Signer.getSignature(
          {
            trader_id: params.agentId,
            signed_at: signedAt,
          },
          privateKey,
          {
            trader_id: "number",
            signed_at: "number",
          } as const,
        );

        const settleStep = async (
          step: string,
          url: string,
          init: RequestInit,
          acceptNotFound = false,
        ): Promise<boolean> => {
          debugLog("update_agent", `settlement.${step}.req`, { url, method: init.method, body: init.body });
          const res = await fetch(url, init);
          const body = await parseResponseBody(res);
          const message = responseErrorMessage(body).toLowerCase();
          const ok = res.ok && body?.result !== false;
          const allowedNotFound = acceptNotFound && message.includes("not found");
          const finalOk = ok || allowedNotFound;
          settlementResult.steps.push({
            step,
            ok: finalOk,
            status: res.status,
            body,
            toleratedNotFound: allowedNotFound || undefined,
          });
          debugLog("update_agent", `settlement.${step}.res`, {
            step,
            ok: finalOk,
            status: res.status,
            body,
            toleratedNotFound: allowedNotFound,
          });
          if (!finalOk) {
            settlementResult.ok = false;
          } else if (allowedNotFound) {
            warnings.push(`Settlement step "${step}" reported trader not found; continuing with best-effort recreation.`);
          }
          return finalOk;
        };

        if (settlementDeleteNeeded || settlementRecreateNeeded) {
          const deleteBody = {
            trader_id: params.agentId,
            signed_at: signedAt,
          };
          const deleteOk = await settleStep(
            "delete",
            `${settlementEngineUrl}/traders/${params.agentId}`,
            {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
                "x-public-key": publicKey,
                "x-signature": settlementDeleteSignature,
              },
              body: JSON.stringify(deleteBody),
            },
            settlementRecreateNeeded,
          );
          if (!deleteOk) {
            result.settlement = settlementResult;
            result.warnings = Array.from(new Set(warnings));
            debugLog("update_agent", "result", result);
            return textResult(result);
          }
        }

        if (settlementCreateNeeded || settlementRecreateNeeded) {
          const missing: string[] = [];
          if (!resolvedMasterWalletAddress) missing.push("masterWalletAddress");
          if (!resolvedWalletAddress) missing.push("walletAddress");
          if (!resolvedSymbol) missing.push("symbol");
          if (resolvedChainId == null) missing.push("chainId");
          if (resolvedBuyLimit == null) missing.push("buyLimit");
          if (missing.length > 0) {
            return textResult({
              ...result,
              settlement: settlementResult,
              error: `Cannot create live settlement trader. Missing companion fields: ${missing.join(", ")}`,
            });
          }

          const createBody: Record<string, unknown> = {
            trader_id: params.agentId,
            owner: npub,
            eth_address: resolvedMasterWalletAddress,
            agent_address: resolvedWalletAddress,
            symbol: resolvedSymbol,
            chain_id: resolvedChainId,
            market_type: targetMarketType,
            venue_type: targetMarketType === "perp" ? "dex_orderbook" : "dex_amm",
            buy_limit_usd: resolvedBuyLimit,
            signed_at: signedAt,
          };
          if (resolvedProtocol) createBody.protocol = resolvedProtocol;
          if (resolvedLeverage != null) createBody.leverage = resolvedLeverage;
          if (hasOwnField(params, "slippage")) createBody.slippage = params.slippage;
          if (hasOwnField(params, "expiration")) createBody.expiration = params.expiration;

          const createSignature = Signer.getSignature(
            createBody,
            privateKey,
            {
              trader_id: "number",
              eth_address: "string",
              symbol: "string",
              chain_id: "number",
              signed_at: "number",
            } as const,
          );
          const createOk = await settleStep(
            "create",
            `${settlementEngineUrl}/traders`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-public-key": publicKey,
                "x-signature": createSignature,
              },
              body: JSON.stringify(createBody),
            },
          );

          if (createOk && (hasOwnField(params, "positionQty") || hasOwnField(params, "isActive"))) {
            const followUpBody: Record<string, unknown> = {
              trader_id: params.agentId,
              signed_at: signedAt,
            };
            if (hasOwnField(params, "positionQty")) followUpBody.position_qty = params.positionQty;
            if (hasOwnField(params, "isActive")) followUpBody.is_active = params.isActive;
            const followUpSignature = Signer.getSignature(
              followUpBody,
              privateKey,
              {
                trader_id: "number",
                signed_at: "number",
              } as const,
            );
            await settleStep(
              "patch_after_create",
              `${settlementEngineUrl}/traders/${params.agentId}`,
              {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  "x-public-key": publicKey,
                  "x-signature": followUpSignature,
                },
                body: JSON.stringify(followUpBody),
              },
            );
          }
        } else if (settlementPatchNeeded) {
          const patchBody: Record<string, unknown> = {
            trader_id: params.agentId,
            signed_at: signedAt,
          };
          if (agentAddressChanged) patchBody.agent_address = resolvedWalletAddress;
          if (hasOwnField(params, "symbol")) patchBody.symbol = params.symbol;
          if (hasOwnField(params, "chainId")) patchBody.chain_id = params.chainId;
          if (hasOwnField(params, "protocol")) patchBody.protocol = params.protocol;
          if (hasOwnField(params, "buyLimit")) patchBody.buy_limit_usd = params.buyLimit;
          if (hasOwnField(params, "positionQty")) patchBody.position_qty = params.positionQty;
          if (hasOwnField(params, "slippage")) patchBody.slippage = params.slippage;
          if (hasOwnField(params, "expiration")) patchBody.expiration = params.expiration;
          if (hasOwnField(params, "leverage")) patchBody.leverage = params.leverage;
          if (hasOwnField(params, "isActive")) patchBody.is_active = params.isActive;

          const patchSignature = Signer.getSignature(
            patchBody,
            privateKey,
            {
              trader_id: "number",
              signed_at: "number",
            } as const,
          );
          await settleStep(
            "patch",
            `${settlementEngineUrl}/traders/${params.agentId}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "x-public-key": publicKey,
                "x-signature": patchSignature,
              },
              body: JSON.stringify(patchBody),
            },
          );
        }

        result.settlement = settlementResult;
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
          "Create the copied live agent via POST /api/copy-agent.",
          "Sync the copied agent to trading-bot via POST /api/notify-agent-creation.",
          "Authorize the selected wallet via POST /api/wallets/authorize.",
          "Register the copied agent on the settlement engine via POST /traders.",
        ],
      };

      return textResult(result);
    },
  });

  api.registerTool({
    name: "deploy_agent",
    description: "Create a trading agent, performing the full billing preflight and any required active NFT/vault setup before agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer and ensures the billing wallet is registered via /api/auth/login before billing checks. Replaces sequential calls to create_agent + notify_trading_bot + register_trader + log_agent_action + get_agent.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      initialCapital: Type.Optional(Type.Number({ description: "Initial capital amount (auto-fetched for live mode)" })),
      mode: Type.Optional(Type.String({ description: '"paper" or "live"', default: "paper" })),
      marketType: Type.Optional(Type.String({ description: '"spot" or "perp"', default: "spot" })),
      strategy: Strategy,
      strategyDescription: Type.Optional(Type.String({ description: "Human-readable strategy summary" })),
      simulationConfig: Type.Optional(SimulationConfig),
      walletId: Type.Optional(Type.Number({ description: "Wallet ID (live mode)" })),
      walletAddress: Type.Optional(Type.String({ description: "Agent wallet address (live mode)" })),
      masterWalletAddress: Type.Optional(Type.String({ description: "Master wallet address (live mode, for settlement)" })),
      symbol: Type.Optional(Type.String({ description: 'Trading pair, e.g. "ETH/USDC"' })),
      protocol: Type.Optional(Type.String({ description: '"hyperliquid"', default: "hyperliquid" })),
      chainId: Type.Optional(Type.Number({ description: "Live mode only: 998=testnet, 999=mainnet" })),
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
        simulationConfig?: { asset_type: string; protocol?: string; chain_id?: number };
        walletId?: number;
        walletAddress?: string;
        masterWalletAddress?: string;
        symbol?: string;
        protocol?: string;
        chainId?: number;
        leverage?: number;
      },
    ) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const mode = params.mode ?? "paper";
      const isLive = mode === "live";
      let marketType: "spot" | "perp" = "spot";
      let liveChainId: 998 | 999 | undefined;
      try {
        marketType = resolveMarketType(mode, params.marketType);
        if (isLive) {
          liveChainId = resolveLiveChainId(params.chainId);
          if (params.walletId == null) {
            return textResult({ error: "walletId is required for live mode" });
          }
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
        const balance = await fetchUsdcBalance(params.masterWalletAddress, liveChainId!);
        if (balance === 0) {
          const appUrl = liveChainId === 999
            ? "https://app.hyperliquid.xyz"
            : "https://app.hyperliquid-testnet.xyz";
          return textResult({
            error: `Wallet ${params.masterWalletAddress} has 0 USDC balance. Deposit USDC before deploying: ${appUrl}`,
          });
        }
        initialCapital = balance;
        debugLog("deploy_agent", "auto-fetched balance", { initialCapital });
      }
      if (initialCapital == null) {
        return textResult({ error: "initialCapital is required for paper mode" });
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
          avatarUrl: "",
          initialCapital,
          mode,
          marketType,
          owner: npub,
          pubkey: Nip19.npubEncode(publicKey),
          isActive: true,
        };
        if (leverage != null) payload.leverage = leverage;
        if (buyLimit != null) payload.buyLimit = buyLimit;
        if (isLive) payload.chainId = liveChainId;
        if (params.simulationConfig) payload.simulationConfig = params.simulationConfig;
        if (params.strategy) payload.strategy = params.strategy;
        if (params.strategyDescription) payload.strategyDescription = params.strategyDescription;
        if (params.walletId != null) payload.walletId = params.walletId;
        if (params.walletAddress) payload.walletAddress = params.walletAddress;
        if (params.symbol) payload.symbol = params.symbol;
        if (params.protocol) payload.protocol = params.protocol;
        if (settlementConfig) payload.settlement_config = settlementConfig;

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

      // Step 2: Notify trading bot
      try {
        const signedAt = Math.floor(Date.now() / 1000);
        const body: Record<string, unknown> = {
          id: agentId,
          name: params.name,
          owner: npub,
          avatar_url: null,
          initial_capital: initialCapital,
          strategy_config: params.strategy,
          description: params.strategyDescription ?? null,
          mode,
          signed_at: signedAt,
          market_type: marketType,
        };
        if (leverage != null) body.leverage = leverage;
        if (isLive && settlementConfig) {
          body.settlement_config = JSON.stringify({
            ...settlementConfig,
            symbol: params.symbol,
            chain_id: liveChainId,
            protocol: params.protocol ?? "hyperliquid",
            buy_limit_usd: buyLimit,
          });
        }
        if (params.simulationConfig) body.simulation_config = params.simulationConfig;

        const signature = Signer.getSignature(body, privateKey, {
          id: "number",
          name: "string",
          initial_capital: "number",
          signed_at: "number",
        } as const);

        debugLog("deploy_agent", "notify.api.req POST bot/agents", body);
        const res = await fetch(`${tradingBotUrl}/agents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-public-key": publicKey,
            "x-signature": signature,
          },
          body: JSON.stringify(body),
        });
        const resBody = res.ok ? await res.json().catch(() => null) : await res.text().catch(() => null);
        debugLog("deploy_agent", "notify.api.res", { status: res.status, responseBody: resBody });
        result.notify = { ok: res.ok };
        if (!res.ok) (result.notify as any).error = `${res.status}`;
      } catch (e: any) {
        result.notify = { ok: false, error: e.message };
      }

      // Step 3: Register trader in settlement engine (live only)
      if (isLive && params.masterWalletAddress && params.walletAddress) {
        try {
          const signedAt = Math.floor(Date.now() / 1000);
          const traderBody: Record<string, unknown> = {
            trader_id: agentId,
            owner: npub,
            eth_address: params.masterWalletAddress,
            agent_address: params.walletAddress,
            symbol: params.symbol!,
            chain_id: liveChainId!,
            market_type: marketType,
            venue_type: marketType === "perp" ? "dex_orderbook" : "dex_amm",
            buy_limit_usd: buyLimit!,
            signed_at: signedAt,
          };
          if (params.protocol) traderBody.protocol = params.protocol;
          const signature = Signer.getSignature(traderBody, privateKey, {
            trader_id: "number",
            eth_address: "string",
            symbol: "string",
            chain_id: "number",
            signed_at: "number",
          } as const);

          debugLog("deploy_agent", "trader.api.req POST /traders", traderBody);
          const res = await fetch(`${settlementEngineUrl}/traders`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-public-key": publicKey,
              "x-signature": signature,
            },
            body: JSON.stringify(traderBody),
          });
          const resBody = res.ok ? await res.json().catch(() => null) : await res.text().catch(() => null);
          debugLog("deploy_agent", "trader.api.res", { status: res.status, responseBody: resBody });
          result.registerTrader = { ok: res.ok };
          if (!res.ok) (result.registerTrader as any).error = `${res.status}`;
        } catch (e: any) {
          result.registerTrader = { ok: false, error: e.message };
        }
      }

      // Step 4: Log action
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

      // Step 5: Verify
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
    description: "Create a live copy-trading agent from an existing source agent. Executes the current UI/backend flow: copy-agent, notify-agent-creation, wallet authorization, settlement registration, and verification.",
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
        const signedAt = Math.floor(Date.now() / 1000);
        const notifySignature = Signer.getSignature(
          {
            id: copiedAgentId,
            name: effectiveName,
            initial_capital: copiedAgentInitialCapital,
            signed_at: signedAt,
          },
          privateKey,
          {
            id: "number",
            name: "string",
            initial_capital: "number",
            signed_at: "number",
          } as const,
        );
        const notifyBody = {
          agentId: copiedAgentId,
          signed_at: signedAt,
          settlement_config: settlementConfig,
        };
        debugLog("deploy_copy_agent", "notify.api.req POST /api/notify-agent-creation", notifyBody);
        const res = await fetch(`${baseUrl}/api/notify-agent-creation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            "x-public-key": publicKey,
            "x-signature": notifySignature,
          },
          body: JSON.stringify(notifyBody),
        });
        const body = await parseResponseBody(res);
        debugLog("deploy_copy_agent", "notify.api.res POST /api/notify-agent-creation", { status: res.status, body });
        result.notify = {
          ok: res.ok,
          status: res.status,
          body,
        };
        if (!res.ok) {
          warnings.push(`Trading-bot notification failed after copy creation: ${responseErrorMessage(body)}`);
        }
      } catch (e: any) {
        result.notify = { ok: false, error: e.message };
        warnings.push(`Trading-bot notification failed after copy creation: ${e.message}`);
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
        const signedAt = Math.floor(Date.now() / 1000);
        const traderBody: Record<string, unknown> = {
          trader_id: copiedAgentId,
          owner: npub,
          eth_address: resolvedMasterWalletAddress,
          symbol: sourceSymbol,
          chain_id: resolvedChainId,
          market_type: sourceMarketType,
          venue_type: sourceMarketType === "perp" ? "dex_orderbook" : "dex_amm",
          buy_limit_usd: resolvedBuyLimit,
          signed_at: signedAt,
        };
        if (normalizeAddress(resolvedMasterWalletAddress) !== normalizeAddress(resolvedWalletAddress)) {
          traderBody.agent_address = resolvedWalletAddress;
        }
        if (resolvedProtocol) {
          traderBody.protocol = resolvedProtocol;
        }
        const traderSignature = Signer.getSignature(
          traderBody,
          privateKey,
          {
            trader_id: "number",
            eth_address: "string",
            symbol: "string",
            chain_id: "number",
            signed_at: "number",
          } as const,
        );
        debugLog("deploy_copy_agent", "trader.api.req POST /traders", traderBody);
        const res = await fetch(`${settlementEngineUrl}/traders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-public-key": publicKey,
            "x-signature": traderSignature,
          },
          body: JSON.stringify(traderBody),
        });
        const body = await parseResponseBody(res);
        debugLog("deploy_copy_agent", "trader.api.res POST /traders", { status: res.status, body });
        result.registerTrader = {
          ok: res.ok,
          status: res.status,
          body,
        };
        if (!res.ok) {
          warnings.push(`Settlement registration failed after copy creation: ${responseErrorMessage(body)}`);
        }
      } catch (e: any) {
        result.registerTrader = { ok: false, error: e.message };
        warnings.push(`Settlement registration failed after copy creation: ${e.message}`);
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
    description: "Delete a trading agent by ID. Removes from all backend services.",
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

      // Step 1: Deactivate trader in settlement engine (live only)
      if (isLive) {
        try {
          const body = { trader_id: params.agentId, signed_at: signedAt };
          const signature = Signer.getSignature(body, privateKey, {
            trader_id: "number", signed_at: "number",
          } as const);
          const res = await fetch(`${settlementEngineUrl}/traders/${params.agentId}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "x-public-key": publicKey, "x-signature": signature },
            body: JSON.stringify(body),
          });
          debugLog("delete_agent", "settlement.res", { status: res.status });
          result.settlement = { ok: res.ok };
        } catch (e: any) {
          result.settlement = { ok: false, error: e.message };
        }
      }

      // Step 2: Delete from trading-data
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
          body: JSON.stringify({ signature, timestamp: signedAt }),
        });
        debugLog("delete_agent", "trading-data.res", { status: res.status });
        result.tradingData = { ok: res.ok };
      } catch (e: any) {
        result.tradingData = { ok: false, error: e.message };
      }

      // Step 3: Delete from trading-bot
      try {
        const deleteSigData = { agent_id: params.agentId, signed_at: signedAt };
        const signature = Signer.getSignature(deleteSigData, privateKey, {
          agent_id: "number",
          signed_at: "number",
        } as const);
        const res = await fetch(`${tradingBotUrl}/agents/${params.agentId}?signed_at=${signedAt}`, {
          method: "DELETE",
          headers: {
            "x-public-key": publicKey,
            "x-signature": signature,
          },
        });
        debugLog("delete_agent", "trading-bot.res", { status: res.status });
        result.tradingBot = { ok: res.ok };
      } catch (e: any) {
        result.tradingBot = { ok: false, error: e.message };
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
    description: "Create a new backtest job for an agent",
    parameters: Type.Object({
      agentId: Type.Number({ description: "Agent ID to backtest" }),
      initialCapital: Type.Number({ description: "Initial capital amount" }),
      startTime: Type.Union([
        Type.String({
          description:
            "Start time (ISO datetime, date-only YYYY-MM-DD, or unix timestamp). If the user mentions a timezone, OpenClaw should resolve it into an ISO datetime with explicit offset before calling this tool. Otherwise naive inputs use the OpenClaw runtime timezone.",
        }),
        Type.Number({
          description:
            "Start unix timestamp in seconds or milliseconds.",
        }),
      ]),
      endTime: Type.Union([
        Type.String({
          description:
            "End time (ISO datetime, date-only YYYY-MM-DD, or unix timestamp). Date-only end dates include the full final local day. If the user mentions a timezone, OpenClaw should resolve it into an ISO datetime with explicit offset before calling this tool. Otherwise naive inputs use the OpenClaw runtime timezone.",
        }),
        Type.Number({
          description:
            "End unix timestamp in seconds or milliseconds.",
        }),
      ]),
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
        startTime: string | number;
        endTime: string | number;
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
      if (!res.ok)
        throw new Error(`create_backtest failed: ${res.status} ${await res.text()}`);
      return textResult(await res.json());
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
    name: "get_backtest_status",
    description: "Check the status of one or more backtest jobs",
    parameters: Type.Object({
      jobIds: Type.Array(Type.String(), { description: "Array of backtest job IDs" }),
    }),
    async execute(_id: string, params: { jobIds: string[] }) {
      const res = await fetch(`${baseUrl}/api/backtests-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: params.jobIds }),
      });
      if (!res.ok) throw new Error(`get_backtest_status failed: ${res.status}`);
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
      const res = await fetch(`${backtestEngineUrl}/jobs/${params.jobId}`);
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
      const res = await fetch(`${backtestEngineUrl}/jobs/${params.jobId}/result`);
      if (!res.ok) throw new Error(`get_backtest_result failed: ${res.status}`);
      return textResult(await res.json());
    },
  });

  // ── Fill execution notifications ─────────────────────────────────

  function formatFillNotification(event: any): string {
    const { agent_name, symbol, side, is_entry, base_amount, execution_price, success } = event;
    if (!success) return `[Trade Failed] ${agent_name}: ${symbol} ${side} failed`;
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

  let telegramBotToken: string | null = null;
  let telegramChatId: string | null = null;

  async function sendNotification(message: string) {
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
  }

  const mqttBrokerUrl: string | undefined = pluginConfig.mqttBrokerUrl;
  if (mqttBrokerUrl) {
    const mqttTopic: string = pluginConfig.mqttFillExecutionsTopic ?? "fill_executions";

    api.registerService({
      id: "fill-notifications",
      start() {
        const mqttPort = pluginConfig.mqttPort ?? 8883;
        const mqttProtocol = mqttPort === 8883 || mqttPort === 443 ? "mqtts" : "mqtt";
        const client = mqtt.connect(`${mqttProtocol}://${mqttBrokerUrl}`, {
          port: mqttPort,
          username: pluginConfig.mqttUsername,
          password: pluginConfig.mqttPassword,
          reconnectPeriod: 5000,
          protocol: mqttProtocol,
        });

        client.on("connect", () => {
          client.subscribe(mqttTopic);
        });

        client.on("message", (_topic: string, payload: Buffer) => {
          try {
            const event = JSON.parse(payload.toString());
            const msg = formatFillNotification(event);
            sendNotification(msg);
          } catch (e: any) {
            debugLog("fill-notifications", "parse-error", e.message);
          }
        });

        this.client = client;
      },
      stop() {
        this.client?.end();
      },
    });
  }
}
