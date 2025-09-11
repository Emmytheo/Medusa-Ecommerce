import { TaxProviderService as MedusaTaxProviderService } from "@medusajs/medusa"
import { In } from "typeorm"

class TaxProviderService extends MedusaTaxProviderService {
  async registerInstalledProviders(providerIds: string[]): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const repo = manager.withRepository(this.taxProviderRepo_)

      // Reset all is_installed flags
      const existing = await repo.find()
      if (existing.length > 0) {
        const ids = existing.map((p) => p.id)
        await repo.update({ id: In(ids) }, { is_installed: false })
      }

      // Add or update providers
      await Promise.all(
        providerIds.map(async (providerId) => {
          const provider = repo.create({ id: providerId, is_installed: true })
          await repo.save(provider)
        })
      )
    })
  }
}

export default TaxProviderService
