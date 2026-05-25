export const DEFAULT_BASE_URL = "https://agent02.decom.dev";
export const DEFAULT_WALLET_AGENT_URL = "https://wallet-agent.decom.dev";
export const DEFAULT_SETTLEMENT_ENGINE_URL = "https://settlement-agent.decom.dev";
export const DEFAULT_BSC_BILLING_RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545";
export const DEFAULT_BSC_ROUTER_ADDRESS = "0x8AEb7abBCfe0ED8baAfa3ddD2CdE39cDBb4d0106";
export const DEFAULT_BSC_WETH_ADDRESS = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
export const DEFAULT_OSWAP_TOKEN_ADDRESS = "0x45eee762aaeA4e5ce317471BDa8782724972Ee19";
export const DEFAULT_BSC_VAULT_ADDRESS = "0x15780a63c8a47dd27c4c7f7d17673929e0cb4d05";
export const DEFAULT_ELIGIBLE_NFT_ADDRESS = "0xc32c70c6cc2338daa3fdfbb25c98f1227c673175";
export const DEFAULT_ELIGIBLE_NFT_EXPLORER_URL = "https://testnet.bscscan.com/address/0xc32c70c6cc2338daa3fdfbb25c98f1227c673175";
export const DEFAULT_ELIGIBLE_NFT_NAME = "Troll NFT";
export const DEFAULT_ELIGIBLE_NFT_MINIMUM_STAKE = 20;
export const DEFAULT_ELIGIBLE_NFT_PROTOCOL_FEE = 10;
export const DEFAULT_ELIGIBLE_NFT_TOTAL_MINTING_FEE = 30;
export const DEFAULT_BILLING_SWAP_SLIPPAGE_BPS = 50;
export const DEFAULT_BILLING_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_BILLING_POLL_TIMEOUT_MS = 90_000;
export const DEFAULT_FALLBACK_SWAP_GAS = 250_000n;
export const DEFAULT_FALLBACK_APPROVE_GAS = 70_000n;
export const DEFAULT_FALLBACK_NFT_STAKE_GAS = 300_000n;
export const DEFAULT_FALLBACK_VAULT_DEPOSIT_GAS = 220_000n;
export const DEFAULT_LIVE_LEVERAGE = 3;

/** Chain IDs valid for spot (AMM/EVM) agents: Ethereum, BSC, BSC Testnet */
export const SPOT_ALLOWED_CHAIN_IDS: readonly number[] = [1, 56, 97];

/** Chain IDs valid for perp (Hyperliquid) agents: testnet and mainnet */
export const PERP_ALLOWED_CHAIN_IDS: readonly number[] = [998, 999];

export function validateChainIdForMarketType(
  chainId: number,
  marketType: "spot" | "perp",
): string | null {
  const allowed = marketType === "spot" ? SPOT_ALLOWED_CHAIN_IDS : PERP_ALLOWED_CHAIN_IDS;
  if (!allowed.includes(chainId)) {
    return `chainId ${chainId} is not valid for ${marketType} agents. Allowed chain IDs for ${marketType}: ${allowed.join(", ")}.`;
  }
  return null;
}

export type EvmChainConfig = {
  chainId: number;
  networkLabel: string;
  rpcUrl: string;
  nativeSymbol: string;
  usdcAddress: string;
  usdcDecimals: number;
};

export const EVM_CHAIN_CONFIGS: Record<number, EvmChainConfig> = {
  1: {
    chainId: 1,
    networkLabel: "Ethereum",
    rpcUrl: "https://cloudflare-eth.com",
    nativeSymbol: "ETH",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
  },
  56: {
    chainId: 56,
    networkLabel: "BNB Chain",
    rpcUrl: "https://bsc-dataseed.binance.org/",
    nativeSymbol: "BNB",
    usdcAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    usdcDecimals: 18,
  },
};

export function getEvmChainConfig(chainId: number): EvmChainConfig | undefined {
  return EVM_CHAIN_CONFIGS[chainId];
}

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export const NFT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function stake(uint256 amount)",
];

export const VAULT_ABI = [
  "function deposit(address beneficiary, uint256 amount)",
];

export const ROUTER_ABI = [
  "function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint256[] memory amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)",
];
