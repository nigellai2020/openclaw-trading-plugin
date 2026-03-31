import type { Wallet } from "ethers";
import type { BillingEnvironment } from "../billing-stage.js";

export type BillingEvmConfig = {
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
  evmUsdcAddress?: string;
  evmUsdcDecimals: number;
};

export type EthHeaders = {
  "x-eth-message": string;
  "x-eth-signature": string;
};

export type GasEstimateSummary = {
  required: boolean;
  gasUnits: string;
  costBnb: string;
  source: "rpc" | "fallback" | "skipped";
};

export type PreparedAgentCreationResult = {
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
    tokenAddress?: string;
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

export type PreparedAgentCreationContext = {
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

export type EligibleNftConfig = {
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
