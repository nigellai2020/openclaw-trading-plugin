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
const DEFAULT_ELIGIBLE_NFT_MINIMUM_STAKE = 100;
const DEFAULT_ELIGIBLE_NFT_PROTOCOL_FEE = 10;
const DEFAULT_ELIGIBLE_NFT_TOTAL_MINTING_FEE = 110;
const DEFAULT_BILLING_SWAP_SLIPPAGE_BPS = 50;
const DEFAULT_BILLING_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BILLING_POLL_TIMEOUT_MS = 90_000;
const DEFAULT_FALLBACK_SWAP_GAS = 250_000n;
const DEFAULT_FALLBACK_APPROVE_GAS = 70_000n;
const DEFAULT_FALLBACK_NFT_STAKE_GAS = 300_000n;
const DEFAULT_FALLBACK_VAULT_DEPOSIT_GAS = 220_000n;

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
  access: {
    npub: string;
    publicKey: string;
    isWhitelisted: boolean;
    canSkipNftPurchase: boolean;
  };
  wallet: {
    address?: string;
    oswapBalance?: string;
    bnbBalance?: string;
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
  return {
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

  async function fetchWhitelistStatus(npub: string): Promise<boolean> {
    const whitelistUrl = `${baseUrl}/api/is-whitelisted/${npub}`;
    debugLog("billing", "api.req /api/is-whitelisted", { url: whitelistUrl, npub });
    const res = await fetch(whitelistUrl);
    const body = await res.json().catch(async () => await res.text().catch(() => null));
    debugLog("billing", "api.res /api/is-whitelisted", { status: res.status, body });
    if (!res.ok) {
      throw new Error(`whitelist check failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    return Boolean(extractApiData(body)?.isWhitelisted);
  }

  async function fetchBillingFeeQuote(): Promise<{
    periodSeconds: number;
    operatingFeeRaw: bigint;
    protocolFeeRaw: bigint;
    strategyFeeRaw: bigint;
    tokenSymbol: string;
  }> {
    const url = `${baseUrl}/api/billing-fee`;
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
    const url = `${baseUrl}/api/billing-subscriptions`;
    debugLog("billing", "api.req /api/billing-subscriptions", { url, walletAddress: wallet.address });
    const { res, body } = await billingFetch(url, wallet);
    debugLog("billing", "api.res /api/billing-subscriptions", { status: res.status, body, walletAddress: wallet.address });
    if (isWalletNotRegisteredError(res.status, body)) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`billing-subscriptions failed: ${res.status} ${responseErrorMessage(body)}`);
    }
    const data = extractApiData<any>(body);
    return Array.isArray(data) ? data : [];
  }

  async function prepareAgentCreationContext(input: {
    name: string;
    mode?: string;
    marketType?: string;
    symbol?: string;
    npub: string;
    publicKey: string;
    privateKey: string;
  }): Promise<PreparedAgentCreationContext> {
    const mode = input.mode ?? "paper";
    const marketType = input.marketType ?? "spot";
    const eligibleOptions = [{
      name: billingEvmConfig.eligibleNftName,
      contractAddress: billingEvmConfig.eligibleNftAddress,
      explorerUrl: billingEvmConfig.eligibleNftExplorerUrl,
      minimumStake: String(billingEvmConfig.eligibleNftMinimumStake),
      protocolFee: String(billingEvmConfig.eligibleNftProtocolFee),
      totalMintingFee: String(billingEvmConfig.eligibleNftTotalMintingFee),
    }];

    const isWhitelisted = await fetchWhitelistStatus(input.npub);
    if (isWhitelisted) {
      const billingWallet = buildBillingWallet();
      return {
        prepared: {
          access: {
            npub: input.npub,
            publicKey: input.publicKey,
            isWhitelisted: true,
            canSkipNftPurchase: true,
          },
          wallet: {
            address: billingWallet.address,
            usesNostrPrivateKey: true,
          },
          nft: {
            required: false,
            hasEligibleNft: false,
            eligibleOptions,
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
            note: "Whitelisted access bypasses NFT purchase and vault funding.",
          },
          executionPlan: {
            agentName: input.name,
            mode,
            marketType,
            symbol: input.symbol ?? null,
            actions: [`Create ${mode} ${marketType} agent directly using whitelist access.`],
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
      };
    }

    const billingWallet = buildBillingWallet();
    await ensureBillingWalletRegistered({
      npub: input.npub,
      publicKey: input.publicKey,
      privateKey: input.privateKey,
      wallet: billingWallet,
    });
    const provider = billingWallet.provider as JsonRpcProvider;
    const tokenRead = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, provider) as any;
    const nftRead = new Contract(billingEvmConfig.eligibleNftAddress, NFT_ABI, provider) as any;
    const routerRead = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, provider) as any;
    const tokenWrite = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, billingWallet) as any;
    const nftWrite = new Contract(billingEvmConfig.eligibleNftAddress, NFT_ABI, billingWallet) as any;
    const vaultWrite = new Contract(billingEvmConfig.vaultAddress, VAULT_ABI, billingWallet) as any;
    const routerWrite = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, billingWallet) as any;
    const [feeQuote, billingBalance, rawOswapBalance, rawBnbBalance, rawNftBalance, rawNftAllowance, rawVaultAllowance, feeData] = await Promise.all([
      fetchBillingFeeQuote(),
      fetchBillingBalanceSnapshot(billingWallet),
      tokenRead.balanceOf(billingWallet.address),
      provider.getBalance(billingWallet.address),
      nftRead.balanceOf(billingWallet.address),
      tokenRead.allowance(billingWallet.address, billingEvmConfig.eligibleNftAddress),
      tokenRead.allowance(billingWallet.address, billingEvmConfig.vaultAddress),
      provider.getFeeData(),
    ]);

    const operatingFeeRaw = feeQuote.operatingFeeRaw;
    const protocolFeeRaw = feeQuote.protocolFeeRaw;
    const strategyFeeRaw = feeQuote.strategyFeeRaw;
    const firstBillingAmountRaw = operatingFeeRaw + protocolFeeRaw + strategyFeeRaw;
    const targetVaultCreditRaw = firstBillingAmountRaw;

    const walletOswapBalanceRaw = BigInt(rawOswapBalance.toString());
    const walletBnbBalanceRaw = BigInt(rawBnbBalance.toString());
    const hasEligibleNft = BigInt(rawNftBalance.toString()) > 0n;
    const existingVaultCreditRaw = billingBalance.availableBalanceRaw;
    const oswapForNftRaw = hasEligibleNft
      ? 0n
      : parseTokenAmount(billingEvmConfig.eligibleNftTotalMintingFee, billingEvmConfig.tokenDecimals);
    const oswapForInitialVaultCreditRaw = maxBigInt(0n, targetVaultCreditRaw - existingVaultCreditRaw);
    const requiredOswapRaw = oswapForNftRaw + oswapForInitialVaultCreditRaw;
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
        () => tokenWrite.approve.estimateGas(billingEvmConfig.eligibleNftAddress, oswapForNftRaw),
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
      actions.push(`Use existing eligible ${billingEvmConfig.eligibleNftName}.`);
    } else {
      actions.push(`Mint ${billingEvmConfig.eligibleNftName} by staking ${formatAmount(oswapForNftRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol}.`);
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
        `Approve ${formatAmount(oswapForNftRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} for NFT contract ${billingEvmConfig.eligibleNftAddress}.`,
      );
    }
    if (vaultApprovalRequired) {
      approvals.push(
        `Approve ${formatAmount(oswapForInitialVaultCreditRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} for vault ${billingEvmConfig.vaultAddress}.`,
      );
    }

    const prepared: PreparedAgentCreationResult = {
      access: {
        npub: input.npub,
        publicKey: input.publicKey,
        isWhitelisted: false,
        canSkipNftPurchase: hasEligibleNft,
      },
      wallet: {
        address: billingWallet.address,
        oswapBalance: formatAmount(walletOswapBalanceRaw, billingEvmConfig.tokenDecimals),
        bnbBalance: formatAmount(walletBnbBalanceRaw, 18, 8),
        usesNostrPrivateKey: true,
      },
      nft: {
        required: !hasEligibleNft,
        hasEligibleNft,
        eligibleOptions,
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
        note: `Vault deposits become billable ${feeQuote.tokenSymbol} credit. The initial deposit target equals the first billing amount: ${formatAmount(firstBillingAmountRaw, billingEvmConfig.tokenDecimals)} ${feeQuote.tokenSymbol} every ${Math.round(feeQuote.periodSeconds / 86_400)} days.`,
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

  // ── Identity & access tools ─────────────────────────────────────

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

  api.registerTool({
    name: "request_trading_access",
    description: "Request trading access (waitlist). A whitelisted user or admin must approve at https://agent.openswap.xyz/admin/waitlist",
    parameters: Type.Object({
      walletAddress: Type.Optional(Type.String({ description: "Your wallet address (optional)" })),
    }),
    async execute(_id: string, params: { walletAddress?: string }) {
      const { privateKey, publicKey, npub } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);
      const res = await fetch(`${baseUrl}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ npub, walletAddress: params.walletAddress }),
      });
      if (!res.ok) throw new Error(`request_trading_access failed: ${res.status} ${await res.text()}`);
      return textResult({
        success: true,
        message: "Access requested. A whitelisted user or admin must approve at https://agent.openswap.xyz/admin/waitlist",
      });
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

  // ── Composite tools ────────────────────────────────────────────

  api.registerTool({
    name: "init_trading_session",
    description: "Initialize a trading session: check/generate Nostr keys, verify trading access, and optionally list wallets (live mode). Replaces sequential calls to get_or_create_nostr_keys + check_trading_access + list_wallets.",
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

      // Step 2: Check trading access
      try {
        const whitelistUrl = `${baseUrl}/api/is-whitelisted/${npub}`;
        debugLog("init_trading_session", "api.req /api/is-whitelisted", { url: whitelistUrl });
        const res = await fetch(whitelistUrl);
        if (!res.ok) {
          const errText = await res.text().catch(() => null);
          debugLog("init_trading_session", "api.res /api/is-whitelisted", { status: res.status, body: errText });
          result.access = { ok: false, error: `check failed: ${res.status}` };
          debugLog("init_trading_session", "result", result);
          return textResult(result);
        }
        const data = await res.json();
        debugLog("init_trading_session", "api.res /api/is-whitelisted", { status: res.status, body: data });
        result.access = { ok: true, hasAccess: data.isWhitelisted };
        if (!data.isWhitelisted) {
          debugLog("init_trading_session", "result", result);
          return textResult(result);
        }
      } catch (e: any) {
        result.access = { ok: false, error: e.message };
        debugLog("init_trading_session", "result", result);
        return textResult(result);
      }

      // Step 3: If live, list wallets
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
    description: "Preflight for direct agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer, ensures the billing wallet is registered via /api/auth/login, checks whitelist/NFT access, calculates OSWAP and vault credit requirements, estimates BNB and gas needs, and returns the full execution plan before any on-chain transaction.",
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
    name: "deploy_agent",
    description: "Create a trading agent, performing the full billing preflight and on-chain NFT/vault setup for non-whitelisted users before agent creation. Uses the user's nostrPrivateKey as the BSC/Ethereum signer and ensures the billing wallet is registered via /api/auth/login before billing checks. Replaces sequential calls to create_agent + notify_trading_bot + register_trader + log_agent_action + get_agent.",
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
      chainId: Type.Optional(Type.Number({ description: "Chain ID (998=testnet)" })),
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
      const marketType = params.marketType ?? "spot";
      const isLive = mode === "live";
      debugLog("deploy_agent", "entry", { ...params, usesNostrPrivateKey: true });
      const result: Record<string, unknown> = {};
      let preparedContext: PreparedAgentCreationContext;
      let billingHeaders: EthHeaders | undefined;
      let billingWallet: Wallet | undefined;
      let billingTransactions: Record<string, any> | undefined;

      // Auto-fetch initial capital for live mode
      let initialCapital = params.initialCapital;
      if (isLive && initialCapital == null && params.masterWalletAddress) {
        const chainId = params.chainId ?? 998;
        const balance = await fetchUsdcBalance(params.masterWalletAddress, chainId);
        if (balance === 0) {
          const appUrl = chainId === 999
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
      const leverage = isLive ? (params.leverage ?? 3) : params.leverage;

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

      const isWhitelisted = preparedContext.prepared.access.isWhitelisted;
      if (isWhitelisted) {
        result.billing = {
          required: false,
          bypassed: true,
          reason: "whitelisted_access",
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
            error: `Insufficient BNB. Shortfall: ${formatAmount(preparedContext.bnbShortfallRaw, 18, 8)} BNB`,
            ...result,
          });
        }

        const swapPath = [billingEvmConfig.wethAddress, billingEvmConfig.tokenAddress];
        const routerContract = new Contract(billingEvmConfig.routerAddress, ROUTER_ABI, activeBillingWallet) as any;
        const tokenContract = new Contract(billingEvmConfig.tokenAddress, ERC20_ABI, activeBillingWallet) as any;
        const nftContract = new Contract(billingEvmConfig.eligibleNftAddress, NFT_ABI, activeBillingWallet) as any;
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
              billingEvmConfig.eligibleNftAddress,
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
        if (params.chainId != null) payload.chainId = params.chainId;
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
            chain_id: params.chainId,
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
          const settlementMarketType = params.marketType ?? "perp";
          const traderBody: Record<string, unknown> = {
            trader_id: agentId,
            owner: npub,
            eth_address: params.masterWalletAddress,
            agent_address: params.walletAddress,
            symbol: params.symbol!,
            chain_id: params.chainId!,
            market_type: settlementMarketType,
            venue_type: settlementMarketType === "perp" ? "dex_orderbook" : "dex_amm",
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

      if (!isWhitelisted && billingWallet) {
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
        const res = await fetch(`${baseUrl}/api/agent/${params.agentId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ signature, timestamp: signedAt }),
        });
        debugLog("delete_agent", "trading-data.res", { status: res.status });
        result.tradingData = { ok: res.ok };
      } catch (e: any) {
        result.tradingData = { ok: false, error: e.message };
      }

      // Step 3: Delete from trading-bot
      try {
        const res = await fetch(`${tradingBotUrl}/agents/${params.agentId}?signed_at=${signedAt}`, {
          method: "DELETE",
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
      startTime: Type.String({ description: "Start time (ISO datetime or unix timestamp)" }),
      endTime: Type.String({ description: "End time (ISO datetime or unix timestamp)" }),
      protocolFee: Type.Optional(Type.Number({ description: "Protocol fee override" })),
      gasFee: Type.Optional(Type.Number({ description: "Gas fee override" })),
      strategy: Type.Optional(Strategy),
    }),
    async execute(
      _id: string,
      params: {
        agentId: number;
        initialCapital: number;
        startTime: string;
        endTime: string;
        protocolFee?: number;
        gasFee?: number;
        strategy?: Record<string, unknown>;
      },
    ) {
      const { privateKey, publicKey } = loadKeys(pluginConfig);
      const auth = getAuthHeader(publicKey, privateKey);

      const payload: Record<string, unknown> = {
        agentId: params.agentId,
        initialCapital: params.initialCapital,
        startTime: params.startTime,
        endTime: params.endTime,
      };
      if (params.protocolFee != null) payload.protocolFee = params.protocolFee;
      if (params.gasFee != null) payload.gasFee = params.gasFee;
      if (params.strategy) payload.strategy = params.strategy;

      const res = await fetch(`${baseUrl}/api/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
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
