const TESTNET_URL_MARKERS = ["prebsc", "data-seed-prebsc", "testnet"];

function hasMarker(url: string | undefined, markers: string[]): boolean {
  if (typeof url !== "string") return false;
  const lower = url.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

// Strip credentials from a URL before putting it in an error/log. Hosted RPC
// providers embed API keys in the path/query/userinfo; the origin (scheme +
// host + port) is enough to diagnose a testnet/mainnet mismatch and carries no secret.
function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[unparseable url]";
  }
}

// The billing RPC determines which BNB chain billing runs on, so the network
// label is derived from it rather than from a separate self-declared flag.
export function resolveBnbNetworkLabel(rpcUrl: string): string {
  return hasMarker(rpcUrl, TESTNET_URL_MARKERS) ? "BNB Chain Testnet" : "BNB Chain Mainnet";
}

/**
 * Fail fast when the configured chain is internally inconsistent. The billing
 * RPC is the source of truth for the BNB chain; the block explorer and the
 * Hyperliquid network must agree with it (e.g. a testnet RPC paired with a
 * mainnet explorer, or Hyperliquid mainnet, is the dangerous real-funds mix).
 * The API service URLs are environment-agnostic infrastructure and not checked.
 */
export function assertBillingNetworkConsistent(input: {
  rpcUrl: string;
  explorerUrl: string;
  defaultHyperliquidNetwork: string;
}): void {
  const mismatches: string[] = [];
  const rpcLooksTestnet = hasMarker(input.rpcUrl, TESTNET_URL_MARKERS);
  const explorerLooksTestnet = hasMarker(input.explorerUrl, TESTNET_URL_MARKERS);
  const network = rpcLooksTestnet ? "testnet" : "mainnet";

  if (explorerLooksTestnet !== rpcLooksTestnet) {
    mismatches.push(
      `bscEligibleNftExplorerUrl (${redactUrl(input.explorerUrl)}) does not match the ${network} billing RPC (${redactUrl(input.rpcUrl)})`,
    );
  }
  if (input.defaultHyperliquidNetwork !== network) {
    mismatches.push(
      `defaultHyperliquidNetwork="${input.defaultHyperliquidNetwork}" but the billing RPC is ${network}`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Billing network configuration is inconsistent:\n- ${mismatches.join("\n- ")}`,
    );
  }
}
