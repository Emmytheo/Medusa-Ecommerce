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
} from "@medusajs/medusa";
import { LineItemRepository } from "@medusajs/medusa/dist/repositories/line-item";
import { OrderRepository } from "../repositories/order";
import { PaymentRepository } from "@medusajs/medusa/dist/repositories/payment";
import { ShippingMethodRepository } from "@medusajs/medusa/dist/repositories/shipping-method";
import { EntityManager } from "typeorm";
import { Product } from "../models/product";
import { Order } from "../models/order";


type InjectedDependencies = {
  manager: EntityManager;
  eventBusService: EventBusService;
  orderService: OrderService;
  productService: ProductService;
  orderRepository: typeof OrderRepository;
  lineItemRepository: typeof LineItemRepository;
  shippingMethodRepository: typeof ShippingMethodRepository;
};

export default class OrderSubscriber {
  protected readonly manager_: EntityManager;
  protected readonly eventBusService_: EventBusService;
  protected readonly orderService_: OrderService;
  protected readonly productService_: ProductService;
  protected readonly orderRepository_: typeof OrderRepository;
  protected readonly lineItemRepository_: typeof LineItemRepository;
  protected readonly shippingMethodRepository_: typeof ShippingMethodRepository;

  constructor({
    manager,
    eventBusService,
    orderService,
    productService,
    orderRepository,
    lineItemRepository,
    shippingMethodRepository,
  }: {
    manager: EntityManager;
    eventBusService: EventBusService;
    orderService: OrderService;
    productService: ProductService;
    orderRepository: typeof OrderRepository;
    lineItemRepository: typeof LineItemRepository;
    shippingMethodRepository: typeof ShippingMethodRepository;
  }) {
    this.manager_ = manager;
    this.eventBusService_ = eventBusService;
    this.orderService_ = orderService;
    this.productService_ = productService;
    this.orderRepository_ = orderRepository;
    this.lineItemRepository_ = lineItemRepository;
    this.shippingMethodRepository_ = shippingMethodRepository;

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
            'collection_id', 'created_at',
            'deleted_at',    'description',
            'discountable',  'external_id',
            'handle',        'height',
            'hs_code',       'id',
            'is_giftcard',   'length',
            'material',      'metadata',
            'mid_code',      'origin_country',
            'status',        'store_id',
            'subtitle',      'thumbnail',
            'title',         'type_id',
            'updated_at',    'weight',
            'width',
            "store_id"
          ],
          relations: [
            'collection',
            'images',
            'options',
            'profiles',
            'sales_channels',
            'store',
            'tags',
            'type',
            'variants',
            'variants.options',
            'variants.prices'
          ]
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
    const lineItemRepo = this.lineItemRepository_;
    const shippingMethodRepo = this.shippingMethodRepository_;

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

        await shippingMethodRepo.save(newShippingMethod);
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
