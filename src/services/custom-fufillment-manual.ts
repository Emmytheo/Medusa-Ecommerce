import {
  AbstractFulfillmentService,
  Address,
  Cart,
  Fulfillment,
  FulfillmentItem,
  FulfillmentProvider,
  FulfillmentService,
  LineItem,
  MedusaContainer,
  Order,
} from "@medusajs/medusa";
import fetch from "node-fetch";
import shippingRules from "../constants/shipping-rules.json";
import StoreRepository from "src/repositories/store";
import { CreateReturnType } from "@medusajs/medusa/dist/types/fulfillment-provider";
import OrderService from "./order";
import OrderRepository from "src/repositories/order";
import FulfillmentRepository from "@medusajs/medusa/dist/repositories/fulfillment";

type GeoLocation = {
  lat: number;
  lon: number;
  city: string;
};

interface ShippingRule {
  location: string;
  transport_type: string;
  base_fare: number;
  distance_cost: number;
  weight_cost: number;
  speed_multiplier?: Record<string, number>;
  zone_modifiers?: Partial<Record<string, number>>;
}

const buildFulfillmentItems = (items: LineItem[]): FulfillmentItem[] => {
  return items.map((item) => ({
    item_id: item.id, // LineItem ID
    quantity: item.quantity, // Quantity to fulfill
    fulfillment_id: "", // This will be populated later (could be empty)
    fulfillment: null, // Will be populated later (link to fulfillment)
    item: item,
  }));
};


class CustomManualFulfillmentService extends AbstractFulfillmentService {
  static identifier = "custom-fulfillment-manual";

  constructor(container, options) {
    super(container);
  }

  async calculatePrice(optionData: any, data: any, cart: Cart): Promise<number> {
    const enrichedAddress = {
      country: cart.shipping_address?.country_code?.toUpperCase() || "",
      province: cart.shipping_address?.province?.toLowerCase() || "",
      city: cart.shipping_address?.city?.toLowerCase() || "",
    };
  
    const itemsByVendor: Record<string, LineItem[]> = {};
    for (const item of cart.items) {
      const storeId = item.variant?.product?.store_id;
      if (!storeId || typeof storeId !== "string") continue;
      if (!itemsByVendor[storeId]) {
        itemsByVendor[storeId] = [];
      }
      itemsByVendor[storeId].push(item);
    }
  
    const vendorGeoCache: Record<string, { country: string; province: string; city: string }> = {};
  
    let totalCost = 0;
  
    for (const [storeId, items] of Object.entries(itemsByVendor)) {
      if (!vendorGeoCache[storeId]) {
        const vendorLocation = await this.getVendorGeo(storeId);
        if (!vendorLocation) continue;
        vendorGeoCache[storeId] = vendorLocation;
      }
  
      const vendorLocation = vendorGeoCache[storeId];

  
      const sameCountry = enrichedAddress.country === vendorLocation.country;
      const sameProvince = enrichedAddress.province === vendorLocation.province;
      const sameCity = enrichedAddress.city === vendorLocation.city;
  
      let cost = 0;
  
      if (!sameCountry) {
        cost = 15; // international default
      } else if (!sameProvince) {
        cost = 10;
      } else if (!sameCity) {
        cost = 5 + Math.random() * 3; // 5 - 8
      } else {
        cost = 2.99 + Math.random() * 2; // 2.99 - 5
      }
  
      totalCost += cost;
    }
  
    return Math.round(totalCost * 100); // return in smallest currency unit
  }
  
  

  

  async getVendorGeo(storeId?: string): Promise<{ country: string; province: string; city: string } | null> {
    if (!storeId) return null;
  
    try {
      const storeRepo = this.container.storeRepository as typeof StoreRepository;
      const store = await storeRepo.findOne({ where: { id: storeId } });
  
      if (!store?.metadata) return null;
  
      const country = typeof store.metadata.country_code === "string" 
        ? store.metadata.country_code.toUpperCase() 
        : "";
  
      const province = typeof store.metadata.province === "string"
        ? store.metadata.province.toLowerCase()
        : "";
  
      const city = typeof store.metadata.city === "string"
        ? store.metadata.city.toLowerCase()
        : "";
  
      if (!country && !province && !city) return null;
  
      return {
        country,
        province,
        city,
      };
    } catch (e: any) {
      console.warn("Vendor geo lookup failed:", e.message);
      return null;
    }
  }
  
  

  async getFulfillmentOptions() {
    return [
      {
        id: "custom-fulfillment-manual",
      },
      {
        id: "custom-fulfillment-manual-return",
        is_return: true,
      },
    ];
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    cart: Cart
  ): Promise<Record<string, unknown>> {
    if (
      [
        "custom-fulfillment-manual",
        "custom-fulfillment-manual-return",
      ].includes(data.id as string)
    ) {
      throw new Error("invalid data");
    }

    return {
      ...data,
    };
  }

  async validateOption() {
    return true;
  }

  async canCalculate() {
    return true;
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: LineItem[],
    order: Order,
    fulfillment: Fulfillment
  ) {
    const fulfillmentService = this.container
      .fulfillmentService as FulfillmentService;
    const orderRepo = this.container.orderRepository as typeof OrderRepository;

    const isChildOrder =
      order.metadata?.type === "childOrder" && order.metadata?.parent;

    if (isChildOrder) {
      const parentOrderId = order.metadata.parent as string;

      // Fetch parent order with related items and fulfillments
      const parentOrder = await orderRepo.findOne({
        where: { id: parentOrderId },
        relations: ["items", "fulfillments", "shipping_methods"],
      });

      // Filter items from the parent that match the child order items
      const parentItemsToFulfill = parentOrder.items.filter((item) =>
        items.some((childItem) => childItem.variant_id === item.variant_id)
      );

      // Extract the shipping method from the parent order
      const shippingMethod = parentOrder.shipping_methods?.[0]; // Select first shipping method (or your logic)

      // Prepare shipping method data
      const shippingMethodData = {
        shipping_method: shippingMethod?.id, // Ensure it's a valid shipping method ID
      };

      // Create a new Fulfillment instance (this invokes any private methods like `beforeInsert`)
      const newFulfillment = new Fulfillment();

      // Manually set the properties on the Fulfillment instance
      newFulfillment.order_id = order.id; // Set order ID
      newFulfillment.items = buildFulfillmentItems(parentItemsToFulfill); // Set fulfillment items
      newFulfillment.metadata = {
        linked_child_order_id: order.id,
        linked_child_fulfillment_id: fulfillment.id,
      };
      newFulfillment.claim_order_id = null; // Set to null or default if not needed
      newFulfillment.claim_order = null; // Same as above
      newFulfillment.swap_id = null; // Same as above
      newFulfillment.swap = null; // Same as above
      //   newFulfillment.status = "pending"; // Or set the appropriate default status
      newFulfillment.updated_at = new Date(); // Set the updated_at timestamp

      // Create the fulfillment for the parent order
      const parentFulfillment = await fulfillmentService.createFulfillment(
        shippingMethodData, // Shipping method data
        parentItemsToFulfill, // Fulfillment items (mapped from parent items)
        parentOrder, // Parent order
        newFulfillment // Full Fulfillment object (created instance)
      );

      // Sync metadata for both child and parent fulfillments
      await this.updateFulfillmentMetadata(fulfillment.id, {
        linked_parent_fulfillment_id: parentFulfillment.id,
        linked_parent_order_id: parentOrderId,
      });

      await this.updateFulfillmentMetadata(parentFulfillment.id as string, {
        linked_child_fulfillment_id: fulfillment.id,
        linked_child_order_id: order.id,
      });
    }

    return {}; // Return empty object as no specific value is expected
  }

  private async updateFulfillmentMetadata(
    fulfillmentId: string,
    metadata: Record<string, any>
  ) {
    const fulfillmentRepo = this.container
      .fulfillmentRepository as typeof FulfillmentRepository;
    const fulfillment = await fulfillmentRepo.findOne({
      where: { id: fulfillmentId },
    });

    if (fulfillment) {
      fulfillment.metadata = {
        ...(fulfillment.metadata || {}),
        ...metadata,
      };
      await fulfillmentRepo.save(fulfillment);
    }
  }

  async cancelFulfillment(fulfillment: Record<string, unknown>): Promise<any> {
    const fulfillmentService = this.container
      .fulfillmentService as FulfillmentService;

    const metadata = fulfillment.metadata as Record<string, any> | undefined;

    if (metadata?.linked_parent_fulfillment_id) {
      try {
        await fulfillmentService.cancelFulfillment(
          metadata.linked_parent_fulfillment_id
        );
      } catch (err) {
        console.warn(
          `Failed to cancel linked parent fulfillment ${metadata.linked_parent_fulfillment_id}:`,
          err
        );
      }
    }

    if (metadata?.linked_child_fulfillment_id) {
      try {
        await fulfillmentService.cancelFulfillment(
          metadata.linked_child_fulfillment_id
        );
      } catch (err) {
        console.warn(
          `Failed to cancel linked child fulfillment ${metadata.linked_child_fulfillment_id}:`,
          err
        );
      }
    }

    return {};
  }

  async createReturn(
    returnOrder: CreateReturnType
  ): Promise<Record<string, unknown>> {
    return {};
  }

  async getTrackingLinks() {
    return [];
  }

  async getFulfillmentDocuments(data: Record<string, unknown>): Promise<any> {
    // assuming you contact a client to
    // retrieve the document
    return [];
  }

  async getReturnDocuments(data: Record<string, unknown>): Promise<any> {
    // assuming you contact a client to
    // retrieve the document
    return [];
  }

  async getShipmentDocuments(data: Record<string, unknown>): Promise<any> {
    // assuming you contact a client to
    // retrieve the document
    return [];
  }

  async retrieveDocuments(
    fulfillmentData: Record<string, unknown>,
    documentType: "invoice" | "label"
  ): Promise<any> {
    // assuming you contact a client to
    // retrieve the document
    return [];
  }
}

export default CustomManualFulfillmentService;
