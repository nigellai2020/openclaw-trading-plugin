import { Keys, Nip19, Signer } from "@scom/scom-signer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}

  const entry = ((cfg.plugins ??= {}).entries ??= {})["trading-plugin"] ??= {};
  const config = (entry.config ??= {});
  if (config.nostrPrivateKey) return false;

  config.nostrPrivateKey = privateKey;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}
