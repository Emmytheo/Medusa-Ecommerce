import { MedusaContainer } from "@medusajs/medusa";
import DeviceGatewayService from "../services/device-gateway-service";

export default async function (container: MedusaContainer): Promise<void> {
  let logger: any = console;
  try {
    logger = container.resolve("logger") || console;
  } catch (_) {}

  logger.info("[DeviceGatewayLoader] 🚀 Bootstrapping Realtime Device Gateway Service...");
  try {
    let gateway: DeviceGatewayService | null = null;
    try {
      gateway = container.resolve("deviceGatewayService");
    } catch (_) {
      try {
        gateway = container.resolve("deviceGatewayServiceService");
      } catch (_) {
        gateway = new DeviceGatewayService(container);
      }
    }
    logger.info("[DeviceGatewayLoader] ✅ Realtime Device Gateway initialized with permanent watchdog.");
  } catch (err: any) {
    logger.warn(`[DeviceGatewayLoader] Loader warning: ${err.message}`);
  }
}
