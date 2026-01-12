import { Lifetime } from "awilix";
import {
  OrderService as MedusaOrderService,
  Order,
  User,
  FindConfig,
  Selector,
  Fulfillment,
  LineItem,
  TrackingLink,
} from "@medusajs/medusa";

class OrderService extends MedusaOrderService {
  static LIFE_TIME = Lifetime.SCOPED;
  protected readonly loggedInUser_: User | null;
  container: any;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments);

    try {
      this.loggedInUser_ = container.loggedInUser;
      this.container = container;
    } catch (e) {
      // avoid errors when the backend first runs
    }
  }

  async retrieve(orderId: string, config?: FindConfig<Order>): Promise<Order> {
    // console.log(
    //   "OrderService retrieve called with orderId:",
    //   orderId,
    //   "and config:",
    //   config
    // );

    if (this.loggedInUser_) {
      if (config.relations.includes("fulfillments")) {
        // console.log("Config relations include fulfillments");
        // config.select = [...(config.select || []), "store_id", "region_id"];
        config.relations.push("store");
        // config.select.push("store_id");
      } else {
        config.relations = [...(config.relations || []), "store", "region"];
        config.select = [...(config.select || []), "store_id", "region_id"];
      }
    }

    let order = await super.retrieve(orderId, config);

    // Only set store_id if it's not already present and order.store.id exists
    if (
      (order.store_id === null || order.store_id === undefined) &&
      this.loggedInUser_ &&
      this.loggedInUser_.store_id &&
      order.store &&
      order.store.id
    ) {
      order.store_id = order.store.id;
    }

    if (
      this.loggedInUser_ &&
      this.loggedInUser_?.store_id &&
      (!order.store_id || order.store_id !== this.loggedInUser_.store_id)
    ) {
      // Check if any of the order items belong to the user's store
      const hasStoreProduct = order.items?.some(
        (item) => item.variant.product?.store_id === this.loggedInUser_.store_id
      );

      if (hasStoreProduct) {
        return order;
      }

      // Throw error if you don't want an order to be accessible to other stores
      throw new Error("Order does not exist in store.");
    }

    return order;
  }

  async list(
    selector: Selector<Order>,
    config?: FindConfig<Order>
  ): Promise<Order[]> {
    // Your existing logic for listing orders
    if (this.loggedInUser_ && this.loggedInUser_.store_id) {
      selector["store_id"] = this.loggedInUser_.store_id;
    }

    console.log("selector", selector);
    console.log("config", config);

    config.select = config.select ?? [];
    config.select.push("store_id");

    config.relations = config.relations ?? [];
    config.relations.push("children", "parent", "store");

    return await super.list(selector, config);
  }

  async listAndCount(
    selector: Selector<Order>,
    config?: FindConfig<Order>
  ): Promise<[Order[], number]> {
    // Your existing logic for listing orders
    if (this.loggedInUser_ && this.loggedInUser_.store_id) {
      selector["store_id"] = this.loggedInUser_.store_id;
    }

    console.log("listAndCount selector", selector);
    console.log("listAndCount config", config);

    config.select.push("store_id");

    config.relations = config.relations ?? [];
    config.relations.push("children", "parent", "store");

    return await super.listAndCount(selector, config);
  }

  async createShipment(
    orderId: string,
    fulfillmentId: string,
    trackingLinks?: TrackingLink[],
    config: {
      metadata: Record<string, unknown>;
      no_notification: boolean;
    } = {
        metadata: {},
        no_notification: false,
      }
  ): Promise<Order> {


    // const order = await this.retrieve(orderId);
    // console.log("createShipment", orderId, fulfillmentId, trackingLinks, config);
    const result = await super.createShipment(
      orderId,
      fulfillmentId,
      trackingLinks ?? [],
      config
    );
    // console.log("result", result);

    const fulfillmentRepo = this.container.fulfillmentRepository;
    const orderRepo = this.container.orderRepository;

    const fulfillment = await fulfillmentRepo.findOne({
      where: { id: fulfillmentId },
      relations: ["items", "items.item"],
    });


    if (!fulfillment) return result;

    const order = await orderRepo.findOne({
      where: { id: orderId },
      relations: [
        "items",
        "fulfillments",
        "fulfillments.items",
        "fulfillments.items.item",
      ],
    });

    if (!order) return result;

    // Helper to check if a fulfillment is already shipped
    const isShipped = (f: Fulfillment) => !!f.shipped_at;

    const childItems: LineItem[] =
      (fulfillment.items || [])
        .map((fi) => fi.item)
        .filter(Boolean) as LineItem[];

    // If the order is a child order, attempt to find and update the parent fulfillment first
    if (order.metadata?.type === "childOrder" && order.metadata?.parent) {
      const parentOrderId = order.metadata.parent as string;
      const parentOrder = await orderRepo.findOne({
        where: { id: parentOrderId },
        relations: [
          "items",
          "fulfillments",
          "fulfillments.items",
          "fulfillments.items.item",
        ],
      });

      if (parentOrder) {
        // Try to locate the corresponding parent fulfillment using existing logic
        let parentFulfillment = this.findExistingFulfillment(
          parentOrder,
          order,
          fulfillment,
          childItems
        );

        // If not found via matching, try linked ID in metadata
        if (!parentFulfillment) {
          const linkedParentId = (fulfillment.metadata || {})
            .linked_parent_fulfillment_id as string;
          if (linkedParentId) {
            parentFulfillment = await fulfillmentRepo.findOne({
              where: { id: linkedParentId },
              relations: ["items", "items.item"],
            });
          }
        }

        if (parentFulfillment && !isShipped(parentFulfillment)) {
          // Ship parent fulfillment
          try {
            await this.createShipment(
              parentOrder.id,
              parentFulfillment.id,
              trackingLinks,
              config
            );
          } catch (e) {
            console.warn(
              `Failed to sync shipment to parent order ${parentOrder.id}:`,
              e
            );
          }
        }
      }
    } else {
      // If the order is not a child order (treat as parent or standalone),
      // check if this fulfillment links to any child and update the child as well.

      // 1. Check direct link in metadata
      const linkedChildId = (fulfillment.metadata || {})
        .linked_child_fulfillment_id as string;
      const linkedChildOrderId = (fulfillment.metadata || {})
        .linked_child_order_id as string;

      if (linkedChildId && linkedChildOrderId) {
        const childFulfillment = await fulfillmentRepo.findOne({
          where: { id: linkedChildId },
        });

        if (childFulfillment && !isShipped(childFulfillment)) {
          try {
            await this.createShipment(
              linkedChildOrderId,
              linkedChildId,
              trackingLinks,
              config
            );
          } catch (e) {
            console.warn(
              `Failed to sync shipment to child order ${linkedChildOrderId}:`,
              e
            );
          }
        }
      }
    }

    return result;
  }

  private findExistingFulfillment(
    parentOrder: Order,
    childOrder: Order,
    childFulfillment: Fulfillment,
    childItems: LineItem[]
  ): Fulfillment | undefined {
    return parentOrder.fulfillments.find((f) => {
      // Check metadata match
      const metaMatch =
        f.metadata?.linked_child_order_id === childOrder.id &&
        f.metadata?.linked_child_fulfillment_id === childFulfillment.id;

      // Check line items match (by variant_id and quantity)
      const parentItemSet = new Set(
        (f.items || []).map(
          (item) => `${item.item.variant_id}:${item.quantity}`
        )
      );
      const childItemSet = new Set(
        childItems.map((item) => `${item.variant_id}:${item.quantity}`)
      );

      const itemsMatch =
        parentItemSet.size === childItemSet.size &&
        [...parentItemSet].every((key) => childItemSet.has(key));

      return metaMatch || itemsMatch;
    });
  }
}

export default OrderService;
