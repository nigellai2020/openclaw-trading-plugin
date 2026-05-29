import { Contract, formatUnits, JsonRpcProvider } from "ethers";
import { ERC20_ABI, getEvmChainConfig } from "../constants/trading.js";

export function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
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