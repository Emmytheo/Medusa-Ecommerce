import {
  createStep,
  StepResponse,
  createWorkflow,
} from "@medusajs/workflows-sdk";
import { MedusaContainer } from "@medusajs/medusa/dist/types/global";
import {
  CartService,
  DraftOrderService,
  EventBusService,
  ProductVariantService,
} from "@medusajs/medusa";
import { Logger } from "winston";
import ExchangeRateService from "../services/exchange-rate";
import {
  ProductVariant,
  MoneyAmount,
  LineItem,
} from "@medusajs/medusa/dist/models";
import { ProductVariantPricesUpdateReq } from "@medusajs/medusa/dist/types/product-variant";
import DraftOrderRepository from "@medusajs/medusa/dist/repositories/draft-order";
import LineItemRepository from "@medusajs/medusa/dist/repositories/line-item";
import ShippingMethodRepository from "@medusajs/medusa/dist/repositories/shipping-method";
import OrderRepository from "src/repositories/order";
import WalletRepository from "src/repositories/wallet";
import WalletAccountRepository from "src/repositories/wallet-account";
import WalletAccountTransactionRepository from "src/repositories/wallet-account-transaction";
import { Product } from "../models/product";
import { Order } from "../models/order";
import { DraftOrderCreateProps } from "@medusajs/medusa/dist/types/draft-orders";
import { User } from "../models/user";
import { Wallet } from "src/models/wallet";
import { WalletAccount } from "src/models/wallet-account";
import { WalletAccountTransaction } from "src/models/wallet-account-transaction";
import WalletPaymentProcessorService from "src/services/wallet-payment-processor";
import { Store } from "../models/store";
import OrderService from "../services/order";
import ProductService from "../services/product";
import UserRepository from "src/repositories/user";
import StoreRepository from "src/repositories/store";

type WorkflowOutput = {
  message: string;
};

type WorkflowInput = User;

const activateWallet = createStep(
  "activateWallet",
  async (input: User, context) => {
    const container: MedusaContainer = context.container;
    const logger: Logger = container.resolve("logger");
    const walletAccountRepository: typeof WalletAccountRepository =
      container.resolve("walletAccountRepository");
    const userRepository: typeof UserRepository =
      container.resolve("userRepository");
    const storeRepository: typeof StoreRepository =
      container.resolve("storeRepository");

    async function findUserByStoreId(store_id: string): Promise<User | null> {
      const result = await userRepository.findOne({ where: { store_id } });
      return result;
    }

    async function getStore(store_id: string): Promise<Store | null> {
      const result = await storeRepository.findOne({ where: { id: store_id } });
      return result;
    }

    async function createWalletAccount(
      user_id: string,
      currencyCode: string
    ): Promise<WalletAccount> {
      const walletAccount = await walletAccountRepository.createAccount(
        user_id,
        currencyCode
      );

      console.log(walletAccount, walletAccount.id);
      return walletAccount;
    }

    console.log(`Checking User Wallet: ${input.email}`);
    try {
      const user = await findUserByStoreId(input.store_id);

      const store = await getStore(input.store_id);

      const walletAccount = await createWalletAccount(
        user.id,
        store.default_currency_code
      );

      return new StepResponse(`Wallet Validated for ${input.email}`);
    } catch (error) {
      logger.error(`Error Validating Wallet:`, error);
      throw error;
    }
  }
);

const activateWalletWorkflow = createWorkflow<WorkflowInput, WorkflowOutput>(
  "activate-wallet-workflow",

  function (input) {
    const message = activateWallet(input);

    return {
      message,
    };
  }
);

export default activateWalletWorkflow;
