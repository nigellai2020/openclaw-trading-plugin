export type UpdateAgentBillingRequirement = "bypassed" | "required" | "unknown";

export type UpdateAgentBillingDecision = {
  requirement: UpdateAgentBillingRequirement;
  requiresBillingHeaders: boolean;
  hasBillingHeaders: boolean;
  canProceed: boolean;
  error?: string;
};

type UpdateAgentBillingInput = {
  requirement: UpdateAgentBillingRequirement;
  billingHeaders?: Record<string, string>;
  billingError?: string | null;
};

export function hasRequiredBillingHeaders(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  const ethMessage = headers["x-eth-message"];
  const ethSignature = headers["x-eth-signature"];
  return typeof ethMessage === "string" &&
    ethMessage.trim().length > 0 &&
    typeof ethSignature === "string" &&
    ethSignature.trim().length > 0;
}

export function decideUpdateAgentBilling(input: UpdateAgentBillingInput): UpdateAgentBillingDecision {
  const requiresBillingHeaders = input.requirement !== "bypassed";
  const hasBillingHeaders = hasRequiredBillingHeaders(input.billingHeaders);

  if (!requiresBillingHeaders || hasBillingHeaders) {
    return {
      requirement: input.requirement,
      requiresBillingHeaders,
      hasBillingHeaders,
      canProceed: true,
    };
  }

  const detail = input.billingError?.trim();
  const error = detail
    ? `Billing auth failed before trading-data update: ${detail}`
    : input.requirement === "unknown"
      ? "Could not confirm billing bypass status and billing auth headers were not generated before trading-data update"
      : "Billing auth headers were not generated before trading-data update";

  return {
    requirement: input.requirement,
    requiresBillingHeaders,
    hasBillingHeaders,
    canProceed: false,
    error,
  };
}
