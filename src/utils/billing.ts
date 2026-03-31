import { formatUnits, parseUnits } from "ethers";
import { resolveBillingStageParams } from "../billing-stage.js";
import {
  DEFAULT_BILLING_POLL_INTERVAL_MS,
  DEFAULT_BILLING_POLL_TIMEOUT_MS,
  DEFAULT_BILLING_SWAP_SLIPPAGE_BPS,
  DEFAULT_BSC_BILLING_RPC_URL,
  DEFAULT_BSC_ROUTER_ADDRESS,
  DEFAULT_BSC_VAULT_ADDRESS,
  DEFAULT_BSC_WETH_ADDRESS,
  DEFAULT_ELIGIBLE_NFT_ADDRESS,
  DEFAULT_ELIGIBLE_NFT_EXPLORER_URL,
  DEFAULT_ELIGIBLE_NFT_MINIMUM_STAKE,
  DEFAULT_ELIGIBLE_NFT_NAME,
  DEFAULT_ELIGIBLE_NFT_PROTOCOL_FEE,
  DEFAULT_ELIGIBLE_NFT_TOTAL_MINTING_FEE,
  DEFAULT_EVM_USDC_DECIMALS,
  DEFAULT_OSWAP_TOKEN_ADDRESS,
} from "../constants/trading.js";
import type { BillingEvmConfig, GasEstimateSummary } from "../types/billing.js";

export function normalizeHexPrivateKey(privateKey: string): string {
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

export function trimAmount(value: string, maxDecimals = 6): string {
  if (!value.includes(".")) return value;
  const [whole, fraction] = value.split(".");
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function formatAmount(raw: bigint, decimals: number, maxDecimals = 6): string {
  return trimAmount(formatUnits(raw, decimals), maxDecimals);
}

export function parseTokenAmount(raw: string | number, decimals: number): bigint {
  return parseUnits(String(raw), decimals);
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function computeAmountInMax(quotedIn: bigint, slippageBps: number): bigint {
  return (quotedIn * BigInt(10_000 + slippageBps)) / 10_000n;
}

export function makeBillingAccessMessage(walletAddress: string, timestamp: number): string {
  return `Billing engine access; wallet: ${walletAddress}; timestamp: ${timestamp}`;
}

export function makeBillingWalletLoginMessage(npub: string, timestamp: number): string {
  return `OSWap login npub: ${npub} timestamp: ${timestamp}`;
}

export function sanitizeForLog(data: unknown): unknown {
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

export function buildBillingEvmConfig(pluginConfig: any): BillingEvmConfig {
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
    evmUsdcAddress: pluginConfig.evmUsdcAddress ?? undefined,
    evmUsdcDecimals: pluginConfig.evmUsdcDecimals ?? DEFAULT_EVM_USDC_DECIMALS,
  };
}

export function buildExplorerUrl(templateUrl: string, configuredAddress: string, contractAddress: string): string {
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

export function isActiveNftConfig(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

export async function estimateStepCost(
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

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
