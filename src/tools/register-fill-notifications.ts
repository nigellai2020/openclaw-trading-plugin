import { Keys } from "@scom/scom-signer";
import { Relay } from "nostr-tools";
import { decrypt } from "nostr-tools/nip04";
import { createTelegramNotifier, formatFillNotification } from "../utils/notifications.js";

export function registerFillNotifications(
  api: any,
  pluginConfig: any,
  debugLog: (tool: string, step: string, data: unknown) => void,
) {
  const privateKey: string | undefined = pluginConfig.nostrPrivateKey;
  if (!privateKey) return;

  const relayUrl: string = pluginConfig.nostrRelayUrl ?? "wss://nos.lol";
  const ownPublicKey = Keys.getPublicKey(privateKey);
  const sendNotification = createTelegramNotifier();

  api.registerService({
    id: "fill-notifications",
    async start() {
      try {
        const relay = await Relay.connect(relayUrl);
        this.relay = relay;
      } catch (e: any) {
        debugLog("fill-notifications", "relay-connect-error", {
          relayUrl,
          message: e?.message ?? String(e),
        });
        return;
      }

      debugLog("fill-notifications", "subscribing", { relayUrl, ownPublicKey });

      const sub = this.relay.subscribe(
        [{ kinds: [4], "#p": [ownPublicKey], since: Math.floor(Date.now() / 1000) }],
        {
          onevent: async (event: any) => {
            if (event?.kind !== 4) return;
            if (!Array.isArray(event.tags)) return;
            const hasRecipientTag = event.tags.some((tag: string[]) => tag[0] === "p" && tag[1] === ownPublicKey);
            if (!hasRecipientTag) return;

            const sender = event.pubkey;
            if (!sender || typeof sender !== "string") return;

            let decrypted = "";
            try {
              decrypted = await decrypt(privateKey, sender, event.content ?? "");
            } catch (e: any) {
              debugLog("fill-notifications", "decrypt-error", {
                message: e?.message ?? String(e),
                eventId: event.id,
                sender,
              });
              return;
            }

            try {
              const parsed = JSON.parse(decrypted);
              if (parsed?.event !== "fill_executed") return;
              const msg = formatFillNotification(parsed);
              await sendNotification(msg);
            } catch (e: any) {
              debugLog("fill-notifications", "parse-error", {
                message: e?.message ?? String(e),
                eventId: event.id,
              });
            }
          },
          onclose: (reason: string) => {
            debugLog("fill-notifications", "subscription-closed", { reason });
          },
        },
      );

      this.subscription = sub;
    },
    stop() {
      this.subscription?.close();
      this.relay?.close();
    },
  });
}
