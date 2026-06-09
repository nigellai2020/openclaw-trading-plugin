// ── Supported pairs matrix ────────────────────────────────────────

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

const VENUES = {
  amm_eth:  { protocol: "amm",     chain_id: 1,   name: "Amm Spot (Ethereum)" },
  amm_bnb:  { protocol: "amm",     chain_id: 56,  name: "Amm Spot (BNB Chain)" },
  hl_testnet:   { protocol: "hyperliquid", chain_id: 998, name: "Hyperliquid Perps (Testnet)" },
  hl_mainnet:   { protocol: "hyperliquid", chain_id: 999, name: "Hyperliquid Perps (Mainnet)" },
} as const;

export const SUPPORTED_PAIRS: SupportedPair[] = [
  // Crypto pairs — venues list only where the pair IS supported
  { symbol: "ETH/USDC",   asset_type: "crypto", venues: [VENUES.amm_eth, VENUES.amm_bnb, VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "BTC/USDC",   asset_type: "crypto", venues: [VENUES.amm_eth, VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "LINK/USDC",  asset_type: "crypto", venues: [VENUES.amm_eth, VENUES.hl_mainnet, VENUES.amm_bnb] },
  { symbol: "PAXG/USDC",  asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "AAVE/USDC",  asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet, VENUES.amm_bnb] },
  { symbol: "UNI/USDC",   asset_type: "crypto", venues: [VENUES.hl_mainnet, VENUES.amm_bnb] },
  { symbol: "ONDO/USDC",  asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "SEI/USDC",   asset_type: "crypto", venues: [VENUES.hl_mainnet] },
  { symbol: "LDO/USDC",   asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "PEPE/USDC",  asset_type: "crypto", venues: [] },
  { symbol: "TAO/USDC",   asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "SKY/USDC",   asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "ENA/USDC",   asset_type: "crypto", venues: [VENUES.hl_mainnet] },
  { symbol: "SYRUP/USDC", asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet] },
  { symbol: "SOL/USDC",   asset_type: "crypto", venues: [VENUES.hl_testnet, VENUES.hl_mainnet, VENUES.amm_bnb] },
  { symbol: "EUR/USDC",   asset_type: "crypto", venues: [] },
  { symbol: "BNB/USDT",   asset_type: "crypto", venues: [] },
  { symbol: "BNB/USDC",   asset_type: "crypto", venues: [VENUES.amm_bnb] },
  { symbol: "BTC/USDT",   asset_type: "crypto", venues: [] },
  { symbol: "CAKE/USDT",  asset_type: "crypto", venues: [] },
];
