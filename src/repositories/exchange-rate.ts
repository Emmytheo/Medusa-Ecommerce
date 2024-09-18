import { In } from "typeorm";
import { ExchangeRate } from "../models/exchange-rate";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const ExchangeRateRepository = dataSource
  .getRepository(ExchangeRate)
  .extend({
    async saveAverageRates(
      averageRates: Record<string, number>
    ): Promise<void> {
      const currencyCodes = Object.keys(averageRates);

      // Fetch existing exchange rates
      const existingRates = await this.find({
        where: { currency_code: In(currencyCodes) },
      });

      const existingRatesMap = new Map<string, ExchangeRate>();
      for (const rate of existingRates) {
        existingRatesMap.set(rate.currency_code, rate);
      }

      const ratesToUpdate: ExchangeRate[] = [];
      const ratesToInsert: ExchangeRate[] = [];

      for (const [currency_code, average_rate] of Object.entries(
        averageRates
      )) {
        const updated_at = new Date();

        if (existingRatesMap.has(currency_code)) {
          // Update existing rate
          const exchangeRate = existingRatesMap.get(currency_code)!;
          exchangeRate.average_rate = average_rate;
          exchangeRate.calculated_at = updated_at;
          ratesToUpdate.push(exchangeRate);
        } else {
          // Insert new rate
          const exchangeRate = this.create({
            currency_code,
            average_rate,
            updated_at,
          });
          ratesToInsert.push(exchangeRate);
        }
      }

      // Perform batch updates and inserts
      if (ratesToUpdate.length > 0) {
        await this.save(ratesToUpdate);
      }

      if (ratesToInsert.length > 0) {
        await this.save(ratesToInsert);
      }
    },
  });

export default ExchangeRateRepository;
