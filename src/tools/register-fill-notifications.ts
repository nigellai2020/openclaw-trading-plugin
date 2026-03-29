import mqtt from "mqtt";
import { createTelegramNotifier, formatFillNotification } from "../utils/notifications.js";

export function registerFillNotifications(
  api: any,
  pluginConfig: any,
  debugLog: (tool: string, step: string, data: unknown) => void,
) {
  const mqttBrokerUrl: string | undefined = pluginConfig.mqttBrokerUrl;
  if (!mqttBrokerUrl) return;

  const mqttTopic: string = pluginConfig.mqttFillExecutionsTopic ?? "fill_executions";
  const sendNotification = createTelegramNotifier();

  api.registerService({
    id: "fill-notifications",
    start() {
      const mqttPort = pluginConfig.mqttPort ?? 8883;
      const mqttProtocol = mqttPort === 8883 || mqttPort === 443 ? "mqtts" : "mqtt";
      const client = mqtt.connect(`${mqttProtocol}://${mqttBrokerUrl}`, {
        port: mqttPort,
        username: pluginConfig.mqttUsername,
        password: pluginConfig.mqttPassword,
        reconnectPeriod: 5000,
        protocol: mqttProtocol,
      });

      client.on("connect", () => {
        client.subscribe(mqttTopic);
      });

      client.on("message", (_topic: string, payload: Buffer) => {
        try {
          const event = JSON.parse(payload.toString());
          const msg = formatFillNotification(event);
          sendNotification(msg);
        } catch (e: any) {
          debugLog("fill-notifications", "parse-error", e.message);
        }
      });

      this.client = client;
    },
    stop() {
      this.client?.end();
    },
  });
}
