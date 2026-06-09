export interface Venue {
  protocol: string;
  chain_id: number;
  name: string;
}

export interface SupportedPair {
  symbol: string;
  asset_type: "crypto";
  venues: Venue[];
}

type ApiMode = {
  mode_key?: string;
  mode_name?: string;
  paper_supported?: boolean;
  live_supported?: boolean;
};

type ApiPair = {
  symbol?: string;
  modes?: ApiMode[];
};

const MODE_KEY_TO_VENUE: Record<string, Venue> = {
  amm_spot_ethereum: { protocol: "amm", chain_id: 1, name: "AMM Spot (Ethereum Chain)" },
  amm_spot_bnb: { protocol: "amm", chain_id: 56, name: "AMM Spot (BNB Chain)" },
  hyperliquid_perps_testnet: { protocol: "hyperliquid", chain_id: 998, name: "Hyperliquid Perps (Testnet)" },
  hyperliquid_perps_mainnet: { protocol: "hyperliquid", chain_id: 999, name: "Hyperliquid Perps (Mainnet)" },
};

export async function fetchSupportedPairsFromApi(baseUrl: string): Promise<SupportedPair[]> {
  const res = await fetch(`${baseUrl}/api/supported-pairs`);
  if (!res.ok) {
    throw new Error(`supported-pairs failed: ${res.status}`);
  }

  const body = await res.json();
  const rows: ApiPair[] = Array.isArray(body?.data)
    ? body.data
    : (Array.isArray(body) ? body : []);

  return rows.flatMap<SupportedPair>((row) => {
    const symbol = typeof row?.symbol === "string" ? row.symbol : "";
    if (!symbol) return [];

    const venues: Venue[] = [];
    const modes = Array.isArray(row.modes) ? row.modes : [];
    for (const mode of modes) {
      if (!mode?.paper_supported && !mode?.live_supported) continue;
      const modeKey = typeof mode.mode_key === "string" ? mode.mode_key : "";
      const mapped = MODE_KEY_TO_VENUE[modeKey];
      if (!mapped) continue;
      venues.push({
        protocol: mapped.protocol,
        chain_id: mapped.chain_id,
        name: typeof mode.mode_name === "string" && mode.mode_name.trim() ? mode.mode_name : mapped.name,
      });
    }

    return [{ symbol, asset_type: "crypto" as const, venues }];
  });
}