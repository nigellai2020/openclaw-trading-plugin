import { Keys, Nip19, Signer } from "@scom/scom-signer";
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_URL,
  DEFAULT_ELIGIBLE_NFT_NAME,
  DEFAULT_FALLBACK_APPROVE_GAS,
  DEFAULT_FALLBACK_NFT_STAKE_GAS,
  DEFAULT_FALLBACK_SWAP_GAS,
  DEFAULT_FALLBACK_VAULT_DEPOSIT_GAS,
  DEFAULT_SETTLEMENT_ENGINE_URL,
  DEFAULT_WALLET_AGENT_URL,
  ERC20_ABI,
  NFT_ABI,
  ROUTER_ABI,
  VAULT_ABI,
} from "../constants/trading.js";
import type {
  BillingEvmConfig,
  EligibleNftConfig,
  EthHeaders,
  PreparedAgentCreationContext,
  PreparedAgentCreationResult,
} from "../types/billing.js";
import { getAuthHeader } from "../utils/auth.js";
import {
  buildBillingEvmConfig,
  buildExplorerUrl,
  computeAmountInMax,
  estimateStepCost,
  formatAmount,
  isActiveNftConfig,
  makeBillingAccessMessage,
  makeBillingWalletLoginMessage,
  maxBigInt,
  normalizeHexPrivateKey,
  parseTokenAmount,
  sanitizeForLog,
  sleep,
} from "../utils/billing.js";

export function createToolsContext(api: any) {
  const pluginConfig = api.config?.plugins?.entries?.["trading-plugin"]?.config ?? api.config ?? {};
  const baseUrl: string = pluginConfig.baseUrl ?? DEFAULT_BASE_URL;
  const tradingBotUrl: string = pluginConfig.tradingBotUrl ?? DEFAULT_BOT_URL;
  const walletAgentUrl: string = pluginConfig.walletAgentUrl ?? DEFAULT_WALLET_AGENT_URL;
  const settlementEngineUrl: string = pluginConfig.settlementEngineUrl ?? DEFAULT_SETTLEMENT_ENGINE_URL;
  const enableAmmSpot: boolean = pluginConfig.enableAmmSpot === true;
  const billingEvmConfig = buildBillingEvmConfig(pluginConfig);
  const billingProvider = new JsonRpcProvider(billingEvmConfig.rpcUrl);

  const debugLogPath = path.join(os.homedir(), ".openclaw", "logs", "trading-debug.json");

  function debugLog(tool: string, step: string, data: unknown) {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      const entry = { ts: new Date().toISOString(), tool, step, data: sanitizeForLog(data) };
      fs.appendFileSync(debugLogPath, JSON.stringify(entry) + "\n");
    } catch {}
  }

  const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
  const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
  const INTEGER_PATTERN = /^-?\d+$/;

  function toSafeInteger(value: string): number | undefined {
    if (!INTEGER_PATTERN.test(value)) return undefined;
    try {
      const big = BigInt(value);
      if (big > MAX_SAFE_BIGINT || big < MIN_SAFE_BIGINT) return undefined;
      return Number(big);
    } catch {
      return undefined;
    }
  }

  function normalizeSafeIntegers<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      const converted = toSafeInteger(value);
      return (converted === undefined ? value : converted) as T;
    }
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => normalizeSafeIntegers(item)) as T;
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeSafeIntegers(nested);
    }
    return normalized as T;
  }

  function extractApiData<T = any>(body: any): T {
    return normalizeSafeIntegers((body?.data ?? body) as T);
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

  function ensureAmmSpotEnabled(mode: string, marketType?: string): void {
    if (mode === "live" && marketType === "spot" && !enableAmmSpot) {
      throw new Error("AMM Spot is disabled by plugin configuration. This stage only supports Hyperliquid Perps.");
    }
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
    return symbol.includes("/") ? "crypto" : "stocks";
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
    input: { walletAddress?: string | null },
  ): any | undefined {
    const normalizedWalletAddress = normalizeAddress(input.walletAddress);
    return wallets.find((wallet) => {
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
    const privateKey = pluginConfig.nostrPrivateKey;
    const auth = typeof privateKey === "string" && privateKey.trim()
      ? getAuthHeader(Keys.getPublicKey(privateKey), privateKey)
      : undefined;
    const res = await fetch(`${baseUrl}/api/agent/${agentId}`, auth
      ? { headers: { Authorization: auth } }
      : undefined);
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
            tokenSymbol: billingEvmConfig.tokenSymbol,
            tokenAddress: billingEvmConfig.tokenAddress,
            vaultAddress: billingEvmConfig.vaultAddress,
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
        tokenSymbol: billingEvmConfig.tokenSymbol,
        tokenAddress: billingEvmConfig.tokenAddress,
        vaultAddress: billingEvmConfig.vaultAddress,
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

  return {
    pluginConfig,
    baseUrl,
    tradingBotUrl,
    walletAgentUrl,
    settlementEngineUrl,
    enableAmmSpot,
    billingEvmConfig,
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
  };
}

export type ToolsContext = ReturnType<typeof createToolsContext>;
