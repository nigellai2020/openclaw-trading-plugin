export type BillingEnvironment = "test" | "prod";

type BillingStageParams = {
  networkLabel: string;
};

const BILLING_STAGE_PARAMS: Record<BillingEnvironment, BillingStageParams> = {
  test: {
    networkLabel: "BNB Chain Testnet",
  },
  prod: {
    networkLabel: "BNB Chain Mainnet",
  },
};

export function resolveBillingStageParams(environment?: string): BillingStageParams & {
  environment: BillingEnvironment;
} {
  const normalized: BillingEnvironment = environment === "prod" ? "prod" : "test";
  return {
    environment: normalized,
    ...BILLING_STAGE_PARAMS[normalized],
  };
}
