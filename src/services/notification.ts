import { NotificationService as MedusaNotificationService } from "@medusajs/medusa"
import { In } from "typeorm"

class NotificationService extends MedusaNotificationService {
  async registerInstalledProviders(providerIds: string[]): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const model = manager.withRepository(this.notificationProviderRepository_)

      // Get all existing notification providers
      const existing = await model.find()
      if (existing.length > 0) {
        const ids = existing.map((p) => p.id)
        await model.update({ id: In(ids) }, { is_installed: false })
      }

      // Register or update new providers
      await Promise.all(
        providerIds.map(async (providerId) => {
          const provider = model.create({
            id: providerId,
            is_installed: true,
          })
          await model.save(provider)
        })
      )
    })
  }
}

export default NotificationService
