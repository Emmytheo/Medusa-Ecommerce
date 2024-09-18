// src/workflows/update-prices-workflow.ts

import {
  createStep,
  StepResponse,
  createWorkflow,
} from "@medusajs/workflows-sdk";
import { MedusaContainer } from "@medusajs/medusa/dist/types/global";
import { ProductService, ProductVariantService } from "@medusajs/medusa";
import { Logger } from "winston";
import ExchangeRateService from "../services/exchange-rate";
import {
  Product,
  ProductVariant,
  MoneyAmount,
} from "@medusajs/medusa/dist/models";
import { ProductVariantPricesUpdateReq } from "@medusajs/medusa/dist/types/product-variant";
// import { ProductVariantPrice } from "@medusajs/medusa";

// ProductVariantPricesUpdateReq

type WorkflowOutput = {
  message: string;
};

const fetchAverageExchangeRates = createStep(
  "fetchAverageExchangeRates",
  async (input: unknown, context) => {
    const container: MedusaContainer = context.container;
    const logger: Logger = container.resolve("logger");
    const exchangeRateService: ExchangeRateService = container.resolve(
      "exchangeRateService"
    );

    try {
      const today = new Date();
      const endDate = today.toISOString().split("T")[0];
      const startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const averageRates: Record<string, number> =
        await exchangeRateService.execute({
          // Base currency is USD
          baseCurrency: "USD",
          startDate,
          endDate,
        });

      // Include USD in the rates
      averageRates["USD"] = 1.0;

      return new StepResponse(averageRates);
    } catch (error) {
      logger.error("Error fetching exchange rates:", error);
      throw error;
    }
  }
);

const updateProductVariantPrices = createStep(
  "updateProductVariantPrices",
  async (averageRates: Record<string, number>, context) => {
    const container: MedusaContainer = context.container;
    const logger: Logger = container.resolve("logger");
    const productService: ProductService = container.resolve("productService");
    const productVariantService: ProductVariantService = container.resolve(
      "productVariantService"
    );

    try {
      // Fetch all products with store relation
      const products: Product[] = await productService.list(
        {},
        { relations: ["store", "variants.prices"] }
      );

      for (const product of products) {
        const store = product.store;
        if (!store || !store.default_currency_code) {
          logger.warn(
            `Product ${product.id} does not have a store with a default currency code. Skipping.`
          );
          continue;
        }

        const baseCurrency = store.default_currency_code.toUpperCase();

        // Check if base currency exchange rate is available
        if (!(baseCurrency in averageRates)) {
          logger.warn(
            `Exchange rate for base currency ${baseCurrency} not available. Skipping product ${product.id}.`
          );
          continue;
        }

        for (const variant of product.variants) {
          const existingPrices: MoneyAmount[] = variant.prices || [];
          const updatedPrices: ProductVariantPricesUpdateReq[] = [];

          // Find the price in the base currency
          const basePriceObj = existingPrices.find(
            (price) => price.currency_code === baseCurrency.toLowerCase()
          );

          if (!basePriceObj) {
            logger.warn(
              `Variant ${variant.id} does not have a price in the base currency ${baseCurrency}. Skipping.`
            );
            continue;
          }

          const basePrice = basePriceObj.amount;

          // Calculate exchange rates from base currency to other currencies
          const rateFromUSDtoBaseCurrency = averageRates[baseCurrency];

          for (const [currency, rateFromUSDtoCurrency] of Object.entries(
            averageRates
          )) {
            const currencyUpper = currency.toUpperCase();

            // Skip if the currency is the base currency
            if (currencyUpper === baseCurrency) {
              continue;
            }

            // Calculate exchange rate from base currency to target currency
            const rateBaseToTarget =
              rateFromUSDtoCurrency / rateFromUSDtoBaseCurrency;

            // Calculate new price
            const newPriceAmount = Math.round(basePrice * rateBaseToTarget);

            // Check if price already exists in this currency
            const existingPrice = existingPrices.find(
              (price) => price.currency_code.toUpperCase() === currencyUpper
            );

            const updatedAt = new Date().toISOString();

            const priceUpdate = {
              currency_code: currency.toLowerCase(),
              amount: newPriceAmount,
              //   updated_at: updatedAt,
            } as ProductVariantPricesUpdateReq;

            if (existingPrice) {
              // Update existing price
              priceUpdate.id = existingPrice.id;
            }

            updatedPrices.push(priceUpdate);
          }

          // Include the base price in the updatedPrices array
          updatedPrices.push({
            id: basePriceObj.id,
            currency_code: baseCurrency.toLowerCase(),
            amount: basePrice,
            // updated_at: new Date().toISOString(),
          });

          // Update the variant with the updated prices
          await productVariantService.updateVariantPrices(
            variant.id,
            updatedPrices
          );
        }
      }

      logger.info("Product variant prices updated successfully.");

      return new StepResponse(`Prices updated successfully.`);
    } catch (error) {
      logger.error("Error updating product variant prices:", error);
      throw error;
    }
  }
);

const updatePricesWorkflow = createWorkflow<unknown, WorkflowOutput>(
  "update-prices-workflow",
  function () {
    const averageRates = fetchAverageExchangeRates();

    const message = updateProductVariantPrices(averageRates);

    return {
      message,
    };
  }
);

export default updatePricesWorkflow;
