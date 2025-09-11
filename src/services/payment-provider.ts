import { PaymentProviderService as MedusaPaymentProviderService } from "@medusajs/medusa";
import { EntityManager, In } from "typeorm";
import { DeepPartial } from "typeorm/common/DeepPartial";

class PaymentProviderService extends MedusaPaymentProviderService {
  async registerInstalledProviders(providerIds: string[]) {
    return await this.atomicPhase_(async (manager) => {
      const model = manager.withRepository(this.paymentProviderRepository_);

      // 🔥 Get all providers first
      const existing = await model.find();
      if (existing.length > 0) {
        const ids = existing.map((p) => p.id);
        await model.update({ id: In(ids) }, { is_installed: false });
      }

      // ✅ Save new/updated providers
      await Promise.all(
        providerIds.map(async (providerId) => {
          const provider = model.create({
            id: providerId,
            is_installed: true,
          });
          await model.save(provider);
        })
      );
    });
  }
}

export default PaymentProviderService;
