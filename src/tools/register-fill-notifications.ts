import { Keys } from "@scom/scom-signer";
import { Relay } from "nostr-tools";
import { decrypt } from "nostr-tools/nip04";
import { createTelegramNotifier, formatBacktestNotification, formatFillNotification } from "../utils/notifications.js";

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

  const MAX_RECONNECT_DELAY_MS = 60_000;
  const BASE_RECONNECT_DELAY_MS = 1_000;

  const seenEventIds = new Set<string>();

  api.registerService({
    id: "fill-notifications",
    _stopped: false,
    _reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,

    async start() {
      this._stopped = false;
      await this._connect(0);
    },

    async _connect(attempt: number) {
      if (this._stopped) return;

      let relay: any;
      try {
        relay = await Relay.connect(relayUrl);
        this.relay = relay;
      } catch (e: any) {
        debugLog("fill-notifications", "relay-connect-error", {
          relayUrl,
          attempt,
          message: e?.message ?? String(e),
        });
        this._scheduleReconnect(attempt);
        return;
      }

      debugLog("fill-notifications", "subscribing", { relayUrl, ownPublicKey, attempt });

      // Reconnect when the relay-level connection drops
      relay.onclose = () => {
        if (this._stopped) return;
        debugLog("fill-notifications", "relay-closed", { relayUrl });
        this._scheduleReconnect(0);
      };

      const sub = relay.subscribe(
        [{ kinds: [4], "#p": [ownPublicKey], since: Math.floor(Date.now() / 1000) }],
        {
          onevent: async (event: any) => {
            if (event?.kind !== 4) return;
            if (!Array.isArray(event.tags)) return;
            const hasRecipientTag = event.tags.some((tag: string[]) => tag[0] === "p" && tag[1] === ownPublicKey);
            if (!hasRecipientTag) return;

            const eventId: string = event.id ?? "";
            if (eventId && seenEventIds.has(eventId)) return;
            if (eventId) seenEventIds.add(eventId);

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
              if (parsed?.event === "fill_executed") {
                const msg = formatFillNotification(parsed);
                await sendNotification(msg);
              } else if (parsed?.event === "backtest_completed") {
                const msg = formatBacktestNotification(parsed);
                await sendNotification(msg);
              }
            } catch (e: any) {
              debugLog("fill-notifications", "parse-error", {
                message: e?.message ?? String(e),
                eventId: event.id,
              });
            }
          },
          onclose: (reason: string) => {
            if (this._stopped) return;
            debugLog("fill-notifications", "subscription-closed", { reason });
            // Subscription closed but relay may still be alive — resubscribe
            this._scheduleReconnect(0);
          },
        },
      );

      this.subscription = sub;
    },

    _scheduleReconnect(attempt: number) {
      if (this._stopped) return;
      // Cancel any pending reconnect before scheduling a new one so multiple
      // onclose firings (e.g. relay drops then subscription closes) collapse
      // into a single reconnect attempt.
      if (this._reconnectTimer !== undefined) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = undefined;
      }
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      debugLog("fill-notifications", "reconnect-scheduled", { delayMs: delay, attempt });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = undefined;
        void this._connect(attempt + 1);
      }, delay);
    },

    stop() {
      this._stopped = true;
      if (this._reconnectTimer !== undefined) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = undefined;
      }
      this.subscription?.close();
      this.relay?.close();
    },
  });
}
