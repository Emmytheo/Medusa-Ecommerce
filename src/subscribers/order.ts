import {
  EventBusService,
  OrderService,
  ProductService,
  LineItem,
  OrderStatus,
  FulfillmentStatus,
  PaymentStatus,
  Selector,
  FindConfig,
  DraftOrderService,
  CartService,
  DraftOrder,
  type SubscriberConfig,
  type SubscriberArgs,
  Logger,
} from "@medusajs/medusa";
import { LineItemRepository } from "@medusajs/medusa/dist/repositories/line-item";
import { OrderRepository } from "../repositories/order";
import { WalletRepository } from "../repositories/wallet";
import { WalletAccountRepository } from "../repositories/wallet-account";
import { WalletAccountTransactionRepository } from "../repositories/wallet-account-transaction";
import { PaymentRepository } from "@medusajs/medusa/dist/repositories/payment";
import { ShippingMethodRepository } from "@medusajs/medusa/dist/repositories/shipping-method";
import { EntityManager } from "typeorm";
import { Product } from "../models/product";
import { Order } from "../models/order";
import DraftOrderRepository from "@medusajs/medusa/dist/repositories/draft-order";
import { DraftOrderCreateProps } from "@medusajs/medusa/dist/types/draft-orders";
import { User } from "../models/user";
import { Wallet } from "src/models/wallet";
import { WalletAccount } from "src/models/wallet-account";
import { WalletAccountTransaction } from "src/models/wallet-account-transaction";
import WalletPaymentProcessorService from "src/services/wallet-payment-processor";
import { Store } from "../models/store";

// type InjectedDependencies = {
//   manager: EntityManager;
//   eventBusService: EventBusService;
//   orderService: OrderService;
//   productService: ProductService;
//   draftOrderService: DraftOrderService;
//   cartService: CartService;
//   orderRepository: typeof OrderRepository;
//   lineItemRepository: typeof LineItemRepository;
//   shippingMethodRepository: typeof ShippingMethodRepository;
//   draftOrderRepository: typeof DraftOrderRepository;
//   walletRepository: typeof WalletRepository;
//   walletAccountRepository: typeof WalletAccountRepository;
//   walletAccountTransactionRepository: typeof WalletAccountTransactionRepository;
// };

// export default class OrderSubscriber {
//   protected readonly manager_: EntityManager;
//   protected readonly eventBusService_: EventBusService;
//   protected readonly orderService_: OrderService;
//   protected readonly draftOrderService_: DraftOrderService;
//   protected readonly productService_: ProductService;
//   protected readonly cartService_: CartService;
//   protected readonly walletPaymentProcessor_: WalletPaymentProcessorService;
//   protected readonly orderRepository_: typeof OrderRepository;
//   protected readonly lineItemRepository_: typeof LineItemRepository;
//   protected readonly shippingMethodRepository_: typeof ShippingMethodRepository;
//   protected readonly draftOrderRepository_: typeof DraftOrderRepository;
//   protected readonly walletRepository_: typeof WalletRepository;
//   protected readonly walletAccountRepository_: typeof WalletAccountRepository;
//   protected readonly walletAccountTransactionRepository_: typeof WalletAccountTransactionRepository;

//   constructor({
//     manager,
//     eventBusService,
//     orderService,
//     productService,
//     orderRepository,
//     lineItemRepository,
//     shippingMethodRepository,
//     draftOrderService,
//     draftOrderRepository,
//     cartService,
//     walletPaymentProcessorService,
//     walletRepository,
//     walletAccountRepository,
//     walletAccountTransactionRepository,
//   }: {
//     manager: EntityManager;
//     eventBusService: EventBusService;
//     orderService: OrderService;
//     productService: ProductService;
//     orderRepository: typeof OrderRepository;
//     lineItemRepository: typeof LineItemRepository;
//     shippingMethodRepository: typeof ShippingMethodRepository;
//     draftOrderRepository: typeof DraftOrderRepository;
//     walletRepository: typeof WalletRepository;
//     walletAccountRepository: typeof WalletAccountRepository;
//     walletAccountTransactionRepository: typeof WalletAccountTransactionRepository;
//     draftOrderService: DraftOrderService;
//     cartService: CartService;
//     walletPaymentProcessorService: WalletPaymentProcessorService;
//   }) {
//     this.manager_ = manager;
//     this.eventBusService_ = eventBusService;
//     this.orderService_ = orderService;
//     this.productService_ = productService;
//     this.orderRepository_ = orderRepository;
//     this.lineItemRepository_ = lineItemRepository;
//     this.shippingMethodRepository_ = shippingMethodRepository;
//     this.draftOrderService_ = draftOrderService;
//     this.draftOrderRepository_ = draftOrderRepository;
//     this.cartService_ = cartService;
//     this.walletRepository_ = walletRepository;
//     this.walletAccountRepository_ = walletAccountRepository;
//     this.walletAccountTransactionRepository_ =
//       walletAccountTransactionRepository;
//     this.walletPaymentProcessor_ = walletPaymentProcessorService;

//     eventBusService.subscribe(
//       OrderService.Events.PLACED,
//       this.handleOrderPlaced.bind(this)
//     );
//   }

//   async handleOrderPlaced({ id }: { id: string }): Promise<void> {
//     console.log("Parent Order ID", id);
//     // Create child orders
//     // Retrieve order
//     const order: Order = await this.orderService_.retrieve(id, {
//       relations: [
//         "items",
//         "items.variant",
//         "cart",
//         "shipping_methods",
//         "payments",
//       ],
//     });

//     // Group items by store id
//     const groupedItems = {};

//     for (const item of order.items) {
//       const product: Product = await this.productService_.retrieve(
//         item.variant.product_id,
//         {
//           select: [
//             "collection_id",
//             "created_at",
//             "deleted_at",
//             "description",
//             "discountable",
//             "external_id",
//             "handle",
//             "height",
//             "hs_code",
//             "id",
//             "is_giftcard",
//             "length",
//             "material",
//             "metadata",
//             "mid_code",
//             "origin_country",
//             "status",
//             "store_id",
//             "subtitle",
//             "thumbnail",
//             "title",
//             "type_id",
//             "updated_at",
//             "weight",
//             "width",
//             "store_id",
//           ],
//           relations: [
//             "collection",
//             "images",
//             "options",
//             "profiles",
//             "sales_channels",
//             "store",
//             "tags",
//             "type",
//             "variants",
//             "variants.options",
//             "variants.prices",
//           ],
//         }
//       );

//       // Extract the relevant properties
//       const { store_id } = product;
//       if (!store_id || !order.parent) {
//         continue;
//       }
//       if (!groupedItems.hasOwnProperty(store_id)) {
//         groupedItems[store_id] = [];
//       }

//       groupedItems[store_id].push(item);
//     }

//     const orderRepo = this.orderRepository_;
//     const orderService = this.orderService_;
//     const draftOrderService = this.draftOrderService_;
//     const draftOrderRepo = this.draftOrderRepository_;
//     const lineItemRepo = this.lineItemRepository_;
//     const shippingMethodRepo = this.shippingMethodRepository_;
//     const cartService = this.cartService_;
//     const walletRepository = this.walletRepository_;
//     const manager = this.manager_;

//     for (const store_id in groupedItems) {
//       // Create line items
//       const items: LineItem[] = groupedItems[store_id].map(
//         (li_itm: LineItem) => {
//           return {
//             ...li_itm,
//             id: null,
//             order_id: null,
//             cart_id: null,
//           };
//         }
//       );

//       const shipping_methods = order.shipping_methods.map((sh_mth) => {
//         return {
//           option_id: sh_mth.shipping_option_id,
//           data: sh_mth.data,
//           price: sh_mth.price,
//         };
//       });

//       var newDraftOrder = await draftOrderService.create({
//         email: order.email,
//         billing_address_id: order.billing_address_id,
//         billing_address: order.billing_address,
//         shipping_address_id: order.shipping_address_id,
//         shipping_address: order.shipping_address,
//         region_id: order.region_id,
//         discounts: order.discounts,
//         customer_id: order.customer_id,
//         shipping_methods: shipping_methods,
//         items: items,
//       });

//       console.log("Child Draft Order Created");

//       await cartService.authorizePayment(newDraftOrder.cart_id, {
//         parentOrder: order.id,
//         payment_provider: "internal-wallet",
//       });

//       console.log("Child Draft Order Payment Authorized");

//       var new_order = await orderService.createFromCart(newDraftOrder.cart_id);

//       console.log("Child Order Created");

//       await orderRepo.save({ ...new_order, store_id: store_id });

//       console.log("Child Order Store Id Updated");

//       await orderService.capturePayment(newDraftOrder.order_id);

//       console.log("Child Order Payment Captured");

//       const user = await this.findUserByStoreId(store_id);

//       const store = await this.getStore(store_id);

//       const walletAccount = await this.createWalletAccount(
//         user.id,
//         store.default_currency_code
//       );

//       await this.recordAndCreditTransaction(
//         user.id,
//         walletAccount,
//         new_order.total,
//         store.default_currency_code
//       );
//       // using new_order, find the store owners wallet, record and credit them here
//     }
//   }

//   async findUserByStoreId(store_id: string): Promise<User | null> {
//     const userRepository = this.manager_.getRepository(User);
//     return await userRepository.findOne({ where: { store_id } });
//   }

//   async getStore(store_id: string): Promise<Store | null> {
//     const storeRepository = this.manager_.getRepository(Store);
//     return await storeRepository.findOne({ where: { id: store_id } });
//   }

//   async createWalletAccount(
//     user_id: string,
//     currencyCode: string
//   ): Promise<WalletAccount> {
//     const walletAccountRepository = this.walletAccountRepository_;
//     const walletAccount = await walletAccountRepository.createAccount(
//       user_id,
//       currencyCode
//     );
//     return await walletAccountRepository.save(walletAccount);
//   }

//   async recordAndCreditTransaction(
//     user_id: string,
//     walletAccount: WalletAccount,
//     amount: number,
//     currencyCode: string
//   ): Promise<WalletAccountTransaction> {
//     const walletPaymentProcessorService = this.walletPaymentProcessor_;

//     return await walletPaymentProcessorService.recordTransaction(
//       user_id,
//       walletAccount.id,
//       amount,
//       currencyCode,
//       "credit"
//     );
//   }
// }

export default async function orderPlacedHandler({
  data,
  eventName,
  container,
  pluginOptions,
}: SubscriberArgs<Record<string, string>>) {
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

  const logger = container.resolve<Logger>("logger");

  const { id } = data;

  logger.info(`Parent Order ID ${id}`);
  // Create child orders
  // Retrieve order
  const order: Order = await this.orderService_.retrieve(id, {
    relations: [
      "items",
      "items.variant",
      "cart",
      "shipping_methods",
      "payments",
    ],
  });

  // Group items by store id
  const groupedItems = {};

  for (const item of order.items) {
    const product: Product = await this.productService_.retrieve(
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
    if (!store_id || !order.parent) {
      continue;
    }
    if (!groupedItems.hasOwnProperty(store_id)) {
      groupedItems[store_id] = [];
    }

    groupedItems[store_id].push(item);
  }

  for (const store_id in groupedItems) {
    // Create line items
    const items: LineItem[] = groupedItems[store_id].map((li_itm: LineItem) => {
      return {
        ...li_itm,
        id: null,
        order_id: null,
        cart_id: null,
      };
    });

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
    });

    logger.info("Child Draft Order Created");

    await cartService.authorizePayment(newDraftOrder.cart_id, {
      parentOrder: order.id,
      payment_provider: "internal-wallet",
    });

    logger.info("Child Draft Order Payment Authorized");

    var new_order = await orderService.createFromCart(newDraftOrder.cart_id);

    logger.info("Child Order Created");

    await orderRepository.save({ ...new_order, store_id: store_id });

    logger.info("Child Order Store Id Updated");

    await orderService.capturePayment(newDraftOrder.order_id);

    logger.info("Child Order Payment Captured");

    const user = await findUserByStoreId(store_id);

    const store = await getStore(store_id);

    const walletAccount = await createWalletAccount(
      user.id,
      store.default_currency_code
    );

    await recordAndCreditTransaction(
      user.id,
      walletAccount,
      new_order.total,
      store.default_currency_code
    );
    // using new_order, find the store owners wallet, record and credit them here
  }
}


async function findUserByStoreId(store_id: string): Promise<User | null> {
  const userRepository = this.manager_.getRepository(User);
  return await userRepository.findOne({ where: { store_id } });
}

async function getStore(store_id: string): Promise<Store | null> {
  const storeRepository = this.manager_.getRepository(Store);
  return await storeRepository.findOne({ where: { id: store_id } });
}

async function createWalletAccount(
  user_id: string,
  currencyCode: string
): Promise<WalletAccount> {
  const walletAccountRepository = this.walletAccountRepository_;
  const walletAccount = await walletAccountRepository.createAccount(
    user_id,
    currencyCode
  );
  return await walletAccountRepository.save(walletAccount);
}

async function recordAndCreditTransaction(
  user_id: string,
  walletAccount: WalletAccount,
  amount: number,
  currencyCode: string
): Promise<WalletAccountTransaction> {
  const walletPaymentProcessorService = this.walletPaymentProcessor_;

  return await walletPaymentProcessorService.recordTransaction(
    user_id,
    walletAccount.id,
    amount,
    currencyCode,
    "credit"
  );
}


export const config: SubscriberConfig = {
  event: OrderService.Events.PLACED,
  // context: {
  //   subscriberId: "order.placed",
  // },
}