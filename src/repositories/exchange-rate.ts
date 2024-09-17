import { ExchangeRate } from "../models/exchange-rate";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const ExchangeRateRepository = dataSource
  .getRepository(ExchangeRate)
  .extend({
    async saveAverageRates(
      averageRates: Record<string, number>
    ): Promise<void> {
      const rates = Object.entries(averageRates).map(
        ([currency_code, average_rate]) => {
          const exchangeRate = this.create();
          exchangeRate.currency_code = currency_code;
          exchangeRate.average_rate = average_rate;
          // exchangeRate.updated_at = new Date();
          return exchangeRate;
        }
      );

      // Use upsert to prevent duplicates
      await this.createQueryBuilder()
        .insert()
        .into(ExchangeRate)
        .values(rates)
        .orUpdate(["average_rate", "updated_at"], ["currency_code"])
        .execute();
    },
  });

export default ExchangeRateRepository;
