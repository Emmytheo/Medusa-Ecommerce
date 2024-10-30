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
} from "@medusajs/medusa";
import { LineItemRepository } from "@medusajs/medusa/dist/repositories/line-item";
import { OrderRepository } from "../repositories/order";
import { PaymentRepository } from "@medusajs/medusa/dist/repositories/payment";
import { ShippingMethodRepository } from "@medusajs/medusa/dist/repositories/shipping-method";
import { EntityManager } from "typeorm";
import { Product } from "../models/product";
import { Order } from "../models/order";
import DraftOrderRepository from "@medusajs/medusa/dist/repositories/draft-order";

type InjectedDependencies = {
  manager: EntityManager;
  eventBusService: EventBusService;
  orderService: OrderService;
  productService: ProductService;
  draftOrderService: DraftOrderService;
  cartService: CartService;
  orderRepository: typeof OrderRepository;
  lineItemRepository: typeof LineItemRepository;
  shippingMethodRepository: typeof ShippingMethodRepository;
  draftOrderRepository: typeof DraftOrderRepository;
};

export default class OrderSubscriber {
  protected readonly manager_: EntityManager;
  protected readonly eventBusService_: EventBusService;
  protected readonly orderService_: OrderService;
  protected readonly draftOrderService_: DraftOrderService;
  protected readonly productService_: ProductService;
  protected readonly cartService_: CartService;
  protected readonly orderRepository_: typeof OrderRepository;
  protected readonly lineItemRepository_: typeof LineItemRepository;
  protected readonly shippingMethodRepository_: typeof ShippingMethodRepository;
  protected readonly draftOrderRepository_: typeof DraftOrderRepository;

  constructor({
    manager,
    eventBusService,
    orderService,
    productService,
    orderRepository,
    lineItemRepository,
    shippingMethodRepository,
    draftOrderService,
    draftOrderRepository,
    cartService,
  }: {
    manager: EntityManager;
    eventBusService: EventBusService;
    orderService: OrderService;
    productService: ProductService;
    orderRepository: typeof OrderRepository;
    lineItemRepository: typeof LineItemRepository;
    shippingMethodRepository: typeof ShippingMethodRepository;
    draftOrderRepository: typeof DraftOrderRepository;
    draftOrderService: DraftOrderService;
    cartService: CartService;
  }) {
    this.manager_ = manager;
    this.eventBusService_ = eventBusService;
    this.orderService_ = orderService;
    this.productService_ = productService;
    this.orderRepository_ = orderRepository;
    this.lineItemRepository_ = lineItemRepository;
    this.shippingMethodRepository_ = shippingMethodRepository;
    this.draftOrderService_ = draftOrderService;
    this.draftOrderRepository_ = draftOrderRepository;
    this.cartService_ = cartService;

    // eventBusService.subscribe(
    //   OrderService.Events.PLACED,
    //   this.handleOrderPlaced.bind(this)
    // );
    // eventBusService.subscribe(
    //   OrderService.Events.CANCELED,
    //   this.checkStatus.bind(this)
    // );
    // eventBusService.subscribe(
    //   OrderService.Events.UPDATED,
    //   this.checkStatus.bind(this)
    // );
    // eventBusService.subscribe(
    //   OrderService.Events.COMPLETED,
    //   this.checkStatus.bind(this)
    // );
  }

  async handleOrderPlaced({ id }: { id: string }): Promise<void> {
    console.log("Here", id);
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
      if (!store_id) {
        continue;
      }
      if (!groupedItems.hasOwnProperty(store_id)) {
        groupedItems[store_id] = [];
      }

      groupedItems[store_id].push(item);
    }

    const orderRepo = this.orderRepository_;
    const orderService = this.orderService_;
    const draftOrderService = this.draftOrderService_;
    const draftOrderRepo = this.draftOrderRepository_;
    const lineItemRepo = this.lineItemRepository_;
    const shippingMethodRepo = this.shippingMethodRepository_;
    const cartService = this.cartService_;

    for (const store_id in groupedItems) {
      // Create order
      const childOrder = orderRepo.create({
        ...order,
        order_parent_id: id,
        store_id: store_id,
        cart_id: null,
        cart: null,
        id: null,
        shipping_methods: [],
      }) as Order;

      const orderResult = await orderRepo.save(childOrder);
      console.log(orderResult);

      // Create shipping methods
      for (const shippingMethod of order.shipping_methods) {
        const newShippingMethod = shippingMethodRepo.create({
          ...shippingMethod,
          id: null,
          cart_id: null,
          cart: null,
          order_id: orderResult.id,
        });

        // await shippingMethodRepo.save(newShippingMethod);
      }

      // Create line items
      const items: LineItem[] = groupedItems[store_id];
      for (const item of items) {
        const newItem = lineItemRepo.create({
          ...item,
          id: null,
          order_id: orderResult.id,
          cart_id: null,
        });
        await lineItemRepo.save(newItem);
      }

      draftOrderService.create({
        email: order.email,
        billing_address_id: order.billing_address_id,
        billing_address: order.billing_address,
        shipping_address_id: order.shipping_address_id,
        shipping_address: order.shipping_address,
        region_id: order.region_id,
        discounts: order.discounts,
        customer_id: order.customer_id,
        shipping_methods: [],
      });

      // cartService.authorizePayment()

      // orderService.createFromCart()

      // orderService.capturePayment()
    }
  }

  public async checkStatus({ id }: { id: string }): Promise<void> {
    // Retrieve order
    const order: Order = await this.orderService_.retrieve(id);

    if (order.order_parent_id) {
      // Retrieve parent
      const orderRepo = this.orderRepository_;
      const parentOrder = await this.orderService_.retrieve(
        order.order_parent_id,
        {
          relations: ["children"],
        }
      );

      const newStatus = this.getStatusFromChildren(parentOrder);
      if (newStatus !== parentOrder.status) {
        switch (newStatus) {
          case OrderStatus.CANCELED:
            this.orderService_.cancel(parentOrder.id);
            break;
          case OrderStatus.ARCHIVED:
            this.orderService_.archive(parentOrder.id);
            break;
          case OrderStatus.COMPLETED:
            this.orderService_.completeOrder(parentOrder.id);
            break;
          default:
            parentOrder.status = newStatus as OrderStatus;
            parentOrder.fulfillment_status = newStatus as FulfillmentStatus;
            parentOrder.payment_status = newStatus as PaymentStatus;
            await orderRepo.save(parentOrder);
        }
      }
    }
  }

  public getStatusFromChildren(order: Order): string {
    if (!order.children) {
      return order.status;
    }

    // Collect all statuses
    let statuses = order.children.map((child) => child.status);

    // Remove duplicate statuses
    statuses = [...new Set(statuses)];

    if (statuses.length === 1) {
      return statuses[0];
    }

    // Remove archived and canceled orders
    statuses = statuses.filter(
      (status) =>
        status !== OrderStatus.CANCELED && status !== OrderStatus.ARCHIVED
    );

    if (!statuses.length) {
      // All child orders are archived or canceled
      return OrderStatus.CANCELED;
    }

    if (statuses.length === 1) {
      return statuses[0];
    }

    // Check if any order requires action
    const hasRequiresAction = statuses.some(
      (status) => status === OrderStatus.REQUIRES_ACTION
    );
    if (hasRequiresAction) {
      return OrderStatus.REQUIRES_ACTION;
    }

    // Since more than one status is left and we filtered out canceled, archived,
    // and requires action statuses, only pending and complete are left. So, return pending
    return OrderStatus.PENDING;
  }
}
