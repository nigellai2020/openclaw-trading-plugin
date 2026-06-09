import { Keys, Nip19, Signer } from "@scom/scom-signer";
import { readOpenClawConfig, writeOpenClawConfig } from "./openclaw-config.js";

export function loadKeys(config: any): {
  privateKey: string;
  publicKey: string;
  npub: string;
} {
  const pk = config?.nostrPrivateKey || undefined;

  if (!pk) {
    throw new Error(
      "No Nostr key configured. Run get_or_create_nostr_keys first.",
    );
  }

  const publicKey = Keys.getPublicKey(pk);
  return { privateKey: pk, publicKey, npub: Nip19.npubEncode(publicKey) };
}

export function getAuthHeader(pubkey: string, privateKey: string): string {
  const sig = Signer.getSignature(
    { pubkey },
    privateKey,
    { pubkey: "string" } as const,
  );
  return `Bearer ${pubkey}:${sig}`;
}

export function persistKeyToConfig(privateKey: string): boolean {
  const cfg: any = readOpenClawConfig();

  const entry = ((cfg.plugins ??= {}).entries ??= {})["trading-plugin"] ??= {};
  const config = (entry.config ??= {});
  if (config.nostrPrivateKey) return false;

  config.nostrPrivateKey = privateKey;
  writeOpenClawConfig(cfg);
  return true;
}
