import { Keys, Nip19, Signer } from "@scom/scom-signer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAuthHeader } from "../utils/auth.js";

export function createToolsContext(api: any) {
  // api.pluginConfig is the user's config merged with the openclaw.plugin.json defaults.
  // Defaults (incl. the test/prod values) live in the manifest — the single source of truth;
  // the user only sets required fields like nostrPrivateKey.
  const pluginConfig = api.pluginConfig ?? {};
  // Defaults for these values live in openclaw.plugin.json; avoid mirroring them in code.
  const baseUrl: string = pluginConfig.baseUrl;
  const walletAgentUrl: string = pluginConfig.walletAgentUrl;
  const settlementEngineUrl: string = pluginConfig.settlementEngineUrl;
  const enableAmmSpot: boolean = pluginConfig.enableAmmSpot === true;
  const defaultHyperliquidNetwork: string = pluginConfig.defaultHyperliquidNetwork;
  const defaultHyperliquidChainId: 998 | 999 = defaultHyperliquidNetwork === "mainnet" ? 999 : 998;
  const webUrl: string = pluginConfig.webUrl;

  const debugLogPath = path.join(os.homedir(), ".openclaw", "logs", "trading-debug.json");

  function debugLog(tool: string, step: string, data: unknown) {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      const entry = { ts: new Date().toISOString(), tool, step, data };
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
      protocol?: string;
      chain_id?: number;
    };
  }): Record<string, unknown> {
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

  return {
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
    buildAgentActionSignature,
    buildWalletActionSignature,
    fetchPublicAgentProfile,
  };
}

export type ToolsContext = ReturnType<typeof createToolsContext>;
