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

type WorkflowInput = {
  id: string;
};

const splitOrder = createStep("splitOrder", async (input: WorkflowInput, context) => {
  const container: MedusaContainer = context.container;
  const logger: Logger = container.resolve("logger");
  const exchangeRateService: ExchangeRateService = container.resolve(
    "exchangeRateService"
  );
  const productService: ProductService = container.resolve("productService");
  const orderRepository: typeof OrderRepository =
    container.resolve("orderRepository");
  const eventBusService: EventBusService = container.resolve("eventBusService");
  const orderService: OrderService = container.resolve("orderService");
  const draftOrderService: DraftOrderService =
    container.resolve("draftOrderService");
  const cartService: CartService = container.resolve("cartService");

  const lineItemRepository: typeof LineItemRepository =
    container.resolve("lineItemRepository");
  const shippingMethodRepository: typeof ShippingMethodRepository =
    container.resolve("shippingMethodRepository");
  const draftOrderRepository: typeof DraftOrderRepository = container.resolve(
    "draftOrderRepository"
  );
  const walletRepository: typeof WalletRepository =
    container.resolve("walletRepository");
  const walletAccountRepository: typeof WalletAccountRepository =
    container.resolve("walletAccountRepository");
  const walletAccountTransactionRepository = container.resolve<
    typeof WalletAccountTransactionRepository
  >("walletAccountTransactionRepository");
  const userRepository: typeof UserRepository =
    container.resolve("userRepository");
  const storeRepository: typeof StoreRepository =
    container.resolve("storeRepository");
  const walletPaymentProcessorService: WalletPaymentProcessorService =
    container.resolve("walletPaymentProcessorService");

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

  async function recordAndCreditTransaction(
    user_id: string,
    walletAccount: WalletAccount,
    amount: number,
    currencyCode: string
  ): Promise<WalletAccountTransaction> {
    return walletPaymentProcessorService.recordTransaction(
      user_id,
      walletAccount.id,
      amount,
      currencyCode,
      "credit"
    );
  }

  console.log(`Parent Order received: ${input}`);
  try {
    // Retrieve order
    const order: Order = await orderService.retrieve(input.id, {
      relations: [
        "items",
        "items.variant",
        "cart",
        "shipping_methods",
        "payments",
      ],
    });

    if(order.metadata.type === 'childOrder'){
      return new StepResponse(
        `Skipping Child Order`
      );
    }

    // Group items by store id
    const groupedItems = {};

    for (const item of order.items) {
      const product: Product = await productService.retrieve(
        item.variant.product_id,
        {
          select: [
            "collection_id",
            "created_at",
            "deleted_at",
            "description",
            "discountable",
            "external_id",
            "handle",
            "height",
            "hs_code",
            "id",
            "is_giftcard",
            "length",
            "material",
            "metadata",
            "mid_code",
            "origin_country",
            "status",
            "store_id",
            "subtitle",
            "thumbnail",
            "title",
            "type_id",
            "updated_at",
            "weight",
            "width",
            "store_id",
          ],
          relations: [
            "collection",
            "images",
            "options",
            "profiles",
            "sales_channels",
            "store",
            "tags",
            "type",
            "variants",
            "variants.options",
            "variants.prices",
          ],
        }
      );

      // Extract the relevant properties
      const { store_id } = product;
      if (!store_id) {
        continue;
      }
      if (!groupedItems.hasOwnProperty(store_id)) {
        groupedItems[store_id] = [];
      }

      groupedItems[store_id].push(item);
    }


    for (const store_id in groupedItems) {
      logger.info(`creating lineitems for ${store_id}`);
      // Create line items
      const items: LineItem[] = groupedItems[store_id].map(
        (li_itm: LineItem) => {
          return {
            ...li_itm,
            id: null,
            order_id: null,
            cart_id: null,
          };
        }
      );


      const shipping_methods = order.shipping_methods.map((sh_mth) => {
        return {
          option_id: sh_mth.shipping_option_id,
          data: sh_mth.data,
          price: sh_mth.price,
        };
      });

      var newDraftOrder = await draftOrderService.create({
        email: order.email,
        billing_address_id: order.billing_address_id,
        billing_address: order.billing_address,
        shipping_address_id: order.shipping_address_id,
        shipping_address: order.shipping_address,
        region_id: order.region_id,
        discounts: order.discounts,
        customer_id: order.customer_id,
        shipping_methods: shipping_methods,
        items: items,
        metadata: {type: 'childOrder', parent: order.id}
      });


      await cartService.setPaymentSessions(newDraftOrder.cart_id);

      await cartService.setPaymentSession(newDraftOrder.cart_id, "manual");

      const nw_cart = await cartService.retrieve(newDraftOrder.cart_id);

      await cartService.authorizePayment(newDraftOrder.cart_id, {
        parentOrder: order.id,
        payment_provider: "manual",
      });


      var new_order = await orderService.createFromCart(newDraftOrder.cart_id);


      await orderRepository.save({ ...new_order, store_id: store_id });

      await orderService.capturePayment(new_order.id);

      const user = await findUserByStoreId(store_id);

      const store = await getStore(store_id);

      const walletAccount = await createWalletAccount(
        user.id,
        store.default_currency_code
      );

      new_order = await orderService.retrieve(new_order.id, {
        select: ["total"],
        relations: ["cart"],
      });

      await recordAndCreditTransaction(
        user.id,
        walletAccount,
        new_order.total,
        store.default_currency_code
      );
    }

    return new StepResponse(
      `Child orders created successfully for order ${input.id}`
    );
  } catch (error) {
    logger.error(`Error finding and spliting order:`, error);
    throw error;
  }
});

const splitParentOrderWorkflow = createWorkflow<WorkflowInput, WorkflowOutput>(
  "split-parent-order-workflow",
  
  function (input) {
    const message = splitOrder(input);

    return {
      message,
    };
  }
);

export default splitParentOrderWorkflow;
