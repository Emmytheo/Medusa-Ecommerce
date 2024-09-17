import { TransactionBaseService } from "@medusajs/medusa";
import axios from "axios";
import moment from "moment";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { AFRICAN_CURRENCIES } from "../constants/african-currencies";
import { ExchangeRateRepository } from "../repositories/exchange-rate";
import { InjectEntityManager, MedusaContext } from "@medusajs/utils";

interface ExchangeRateOptions {
  api_key: string;
}

interface ExecuteData {
  baseCurrency?: string;
  startDate: string;
  endDate: string;
}

@Service()
class ExchangeRateService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly apiKey_: string;
  protected readonly africanCurrencies_: string[];
  protected readonly exchangeRateRepository_: typeof ExchangeRateRepository;

  

  constructor(container) {
    super(container);
    // ...
    this.logger_ = container.logger;
    this.apiKey_ = process.env.OPEN_EXCHANGE_RATES_API_KEY;
    this.africanCurrencies_ = AFRICAN_CURRENCIES;
    this.exchangeRateRepository_ = container.exchangeRateRepository;
  }

  /**
   * Executes the job.
   * @param data - The data passed to the job.
   */
  async execute(data: ExecuteData): Promise<Record<string, number>> {
    const exchangeRateRepo = this.activeManager_.withRepository(
      this.exchangeRateRepository_
    );

    try {
      const { baseCurrency, startDate, endDate } = data;

      // Validate input dates
      const start = moment(startDate);
      const end = moment(endDate);
      if (!start.isValid() || !end.isValid()) {
        throw new Error("Invalid start or end date");
      }

      // Ensure startDate is before endDate
      if (start.isAfter(end)) {
        throw new Error("Start date must be before end date");
      }

      const dateRange: string[] = [];
      let currDate = start.clone();

      // Build date range array
      while (currDate.isSameOrBefore(end)) {
        dateRange.push(currDate.format("YYYY-MM-DD"));
        currDate.add(1, "day");
      }

      const exchangeRates: Record<string, number[]> = {};

      // Fetch exchange rates for each date
      for (const date of dateRange) {
        const response = await axios.get(
          `https://openexchangerates.org/api/historical/${date}.json`,
          {
            params: {
              app_id: this.apiKey_,
              base: baseCurrency,
              symbols: this.africanCurrencies_.join(","),
            },
          }
        );

        const rates = response.data.rates as Record<string, number>;

        // Accumulate rates
        for (const [currency, rate] of Object.entries(rates)) {
          if (!exchangeRates[currency]) {
            exchangeRates[currency] = [];
          }
          exchangeRates[currency].push(rate);
        }
      }

      // Calculate averages
      const averageRates: Record<string, number> = {};

      for (const [currency, rates] of Object.entries(exchangeRates)) {
        const sum = rates.reduce((acc, rate) => acc + rate, 0);
        const average = sum / rates.length;
        averageRates[currency] = average;
      }

      // Save the averages to the database
      await exchangeRateRepo.saveAverageRates(averageRates);

      // Log the result
      this.logger_.info("Average Exchange Rates calculated and saved.");

      // Return the data for further processing
      return averageRates;
    } catch (error) {
      this.logger_.error("Exchange Rate Job failed:", error);
      throw error; // Rethrow to ensure the job registers as failed
    }
  }
}

export default ExchangeRateService;