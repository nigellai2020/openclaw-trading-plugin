import { Contract, formatUnits, JsonRpcProvider } from "ethers";
import { DEFAULT_LIVE_LEVERAGE, ERC20_ABI, getEvmChainConfig } from "../constants/trading.js";

export function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export async function fetchUsdcBalance(masterWalletAddress: string, chainId: number): Promise<number> {
  const apiUrl = chainId === 999
    ? "https://api.hyperliquid.xyz/info"
    : "https://api.hyperliquid-testnet.xyz/info";

  const chRes = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: masterWalletAddress }),
  });
  if (!chRes.ok) throw new Error(`clearinghouseState failed: ${chRes.status}`);
  const chData = await chRes.json();
  const withdrawable = parseFloat(chData.withdrawable ?? "0");
  if (withdrawable > 0) return withdrawable;

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

export async function fetchEvmNativeBalance(address: string, rpcUrl: string): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl);
  const raw = await provider.getBalance(address);
  return parseFloat(formatUnits(raw, 18));
}

export async function fetchEvmUsdcBalance(
  address: string,
  rpcUrl: string,
  usdcAddress: string,
  usdcDecimals = 18,
): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(usdcAddress, ERC20_ABI, provider);
  const raw = await contract.balanceOf(address);
  return parseFloat(formatUnits(raw, usdcDecimals));
}

export type EvmWalletBalances = {
  nativeBalance: number;
  usdcBalance: number;
};

export async function fetchEvmWalletBalances(
  address: string,
  rpcUrl: string,
  usdcAddress?: string,
  usdcDecimals = 18,
): Promise<EvmWalletBalances> {
  const provider = new JsonRpcProvider(rpcUrl);
  const nativeRaw = await provider.getBalance(address);
  const nativeBalance = parseFloat(formatUnits(nativeRaw, 18));

  let usdcBalance = 0;
  if (usdcAddress) {
    const contract = new Contract(usdcAddress, ERC20_ABI, provider);
    const usdcRaw = await contract.balanceOf(address);
    usdcBalance = parseFloat(formatUnits(usdcRaw, usdcDecimals));
  }

  return { nativeBalance, usdcBalance };
}

export async function deriveDefaultLiveBuyLimit(
  masterWalletAddress: string,
  chainId: number,
  leverage = DEFAULT_LIVE_LEVERAGE,
): Promise<{ initialCapital: number; leverage: number; buyLimit: number } | null> {
  if (chainId === 998 || chainId === 999) {
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

  const chainConfig = getEvmChainConfig(chainId);
  if (chainConfig) {
    const balances = await fetchEvmWalletBalances(
      masterWalletAddress,
      chainConfig.rpcUrl,
      chainConfig.usdcAddress,
      chainConfig.usdcDecimals,
    );
    const initialCapital = balances.usdcBalance;
    if (initialCapital === 0) {
      throw new Error(
        `Wallet ${masterWalletAddress} has 0 USDC balance on ${chainConfig.networkLabel}. Deposit USDC before deploying.`,
      );
    }
    return {
      initialCapital,
      leverage,
      buyLimit: initialCapital * leverage,
    };
  }

  return null;
}
