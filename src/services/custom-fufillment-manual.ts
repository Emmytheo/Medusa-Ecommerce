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
  transport_type: "intra-state" | "inter-state" | "international";
  base_fare: number;
  distance_cost_km?: number;
  weight_cost_per_kg?: number;
  zone_modifiers?: Record<string, number>;
  speed_multiplier?: Record<string, number>;
  state_modifiers?: Record<string, number>; // For inter-state pricing
}

interface VendorLocation {
  country: string;
  province: string;
  city: string;
  coordinates?: { lat: number; lng: number };
}

interface ShippingCalculatorConfig {
  default_inter_state_cost: number;
  default_intra_state_cost: number;
  default_international_cost: number;
  fallback_speed_multiplier: Record<string, number>;
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

  // The state fare matrix constant (imported or defined in the class)
  public readonly stateFareMatrix = {
    ...shippingRules,
  };

  async calculatePrice(
    optionData: any,
    data: any,
    cart: Cart
  ): Promise<number> {
    const config: ShippingCalculatorConfig = {
      default_inter_state_cost: 3000,
      default_intra_state_cost: 5,
      default_international_cost: 2000,
      fallback_speed_multiplier: {
        standard: 1,
        express: 1.4,
        overnight: 1.8,
      },
    };

    console.log("Calculating price for cart:", cart.id);
    const enrichedAddress = {
      country: cart.shipping_address?.country_code?.toUpperCase() || "",
      province: cart.shipping_address?.province?.toLowerCase() || "",
      city: cart.shipping_address?.city?.toLowerCase() || "",
    };

    console.log("Enriched customer address:", enrichedAddress);

    // Group items by vendor
    const itemsByVendor: Record<string, LineItem[]> = {};
    for (const item of cart.items) {
      const storeId = item.variant?.product?.store_id;
      if (!storeId || typeof storeId !== "string") continue;
      if (!itemsByVendor[storeId]) {
        itemsByVendor[storeId] = [];
      }
      itemsByVendor[storeId].push(item);
    }

    const vendorGeoCache: Record<string, VendorLocation> = {};

    let totalCost = 0;

    for (const [storeId, items] of Object.entries(itemsByVendor)) {
      if (!vendorGeoCache[storeId]) {
        const vendorLocation = await this.getVendorGeo(storeId);
        if (!vendorLocation) continue;
        vendorGeoCache[storeId] = vendorLocation;
      }

      const vendorLocation = vendorGeoCache[storeId];
      console.log("Vendor location for store", storeId, ":", vendorLocation);
      const shippingScenario = this.determineShippingScenario(
        enrichedAddress,
        vendorLocation
      );

      console.log("Shipping scenario for vendor", storeId, ":", shippingScenario);

      const totalWeight = this.calculateTotalWeight(items);

      let cost = 0;

      switch (shippingScenario.type) {
        case "international":
          cost = await this.calculateInternationalCost(
            vendorLocation,
            enrichedAddress,
            totalWeight,
            config
          );
          break;

        case "inter-state":
          cost = await this.calculateInterStateCost(
            vendorLocation,
            enrichedAddress,
            totalWeight,
            optionData,
            config
          );
          break;

        case "intra-state":
          cost = await this.calculateIntraStateCost(
            vendorLocation,
            enrichedAddress,
            totalWeight,
            optionData,
            config
          );
          break;

        case "same-city":
          cost = this.calculateSameCityCost(totalWeight, config);
          break;
        
        default:
          cost = 2000;
          break;
      }

      console.log("Calculated cost:", cost, "for vendor:", storeId);

      totalCost += cost;
    }

    
    console.log("Total calculated shipping cost:", totalCost);


    return Math.round(totalCost * 100);
  }

  private async calculateInterStateCost(
    vendorLocation: VendorLocation,
    customerAddress: any,
    totalWeight: number,
    optionData: any,
    config: ShippingCalculatorConfig
  ): Promise<number> {
    const vendorState = this.normalizeStateName(vendorLocation.province);
    const customerState = this.normalizeStateName(customerAddress.province);

    // Get fare matrix for vendor state
    const vendorFareData = this.stateFareMatrix.fare_matrix[vendorState];
    if (!vendorFareData) {
      // Fallback to default cost if state not found
      return config.default_inter_state_cost + totalWeight * 2;
    }

    // Find the customer state in the vendor's state fares
    let stateFare = this.findStateFare(
      vendorFareData.state_fares,
      customerState
    );

    if (stateFare === null) {
      // If state not found, use extreme zone as fallback
      const extremeFares = vendorFareData.state_fares.extreme;
      if (extremeFares && Object.keys(extremeFares).length > 0) {
        stateFare = Object.values(extremeFares)[0] as number;
      } else {
        // Final fallback
        stateFare = (vendorFareData.base_fare as number) + 3500; // base + extreme modifier
      }
    }

    // Calculate weight cost
    const weightCost = totalWeight * vendorFareData.weight_cost_per_kg;

    // Apply speed multiplier
    const speedOption = optionData.speed || "standard";
    const speedMultiplier =
      this.stateFareMatrix.speed_multipliers[speedOption] || 1;

    return (stateFare + weightCost) * speedMultiplier;
  }

  private async calculateIntraStateCost(
    vendorLocation: VendorLocation,
    customerAddress: any,
    totalWeight: number,
    optionData: any,
    config: ShippingCalculatorConfig
  ): Promise<number> {
    const stateName = this.normalizeStateName(vendorLocation.province);

    // Get fare data for the state
    const stateFareData = this.stateFareMatrix.fare_matrix[stateName];
    if (!stateFareData) {
      return config.default_intra_state_cost + totalWeight * 1.5;
    }

    // For intra-state, use base fare + weight cost
    const baseCost = stateFareData.base_fare;
    const weightCost = totalWeight * stateFareData.weight_cost_per_kg;

    // Apply speed multiplier
    const speedOption = optionData.speed || "standard";
    const speedMultiplier =
      this.stateFareMatrix.speed_multipliers[speedOption] || 1;

    return (baseCost + weightCost) * speedMultiplier;
  }

  private findStateFare(stateFares: any, targetState: string): number | null {
    // Check each zone for the target state
    const zones = ["neighboring", "near", "mid", "far", "extreme"];

    for (const zone of zones) {
      if (stateFares[zone] && stateFares[zone][targetState]) {
        return stateFares[zone][targetState];
      }
    }

    return null;
  }

  private normalizeStateName(stateName: string): string {
    if (!stateName) return "";

    // Convert to title case and handle special cases
    const normalized = stateName
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    // Handle Federal Capital Territory
    if (normalized.includes("Federal") || normalized.includes("Abuja")) {
      return "Federal Capital Territory";
    }

    return normalized;
  }

  private determineShippingScenario(
    destination: VendorLocation,
    origin: VendorLocation
  ): { type: "international" | "inter-state" | "intra-state" | "same-city" } {
    const sameCountry = destination.country === origin.country;
    const sameProvince = destination.province === origin.province;
    const sameCity = destination.city === origin.city;

    if (!sameCountry) return { type: "international" };
    if (!sameProvince) return { type: "inter-state" };
    if (!sameCity) return { type: "intra-state" };
    return { type: "same-city" };
  }

  private determineTransportType(rule: any): ShippingRule["transport_type"] {
    if (rule.transport_type) return rule.transport_type;
    if (rule.inter_state || rule.isInterState) return "inter-state";
    return "intra-state"; // Default fallback
  }

  private calculateTotalWeight(items: LineItem[]): number {
    return items.reduce((acc, item) => {
      const variant = item.variant as any;
      const weight = variant?.weight ?? variant?.weight_in_kg ?? 0;
      return acc + weight * (item.quantity || 1);
    }, 0);
  }

  private async calculateInternationalCost(
    vendorLocation: VendorLocation,
    destination: VendorLocation,
    totalWeight: number,
    config: ShippingCalculatorConfig
  ): Promise<number> {
    // Enhanced international shipping calculation
    const baseCost = config.default_international_cost;
    const weightCost = totalWeight * 2; // $2 per kg for international

    return baseCost + weightCost;
  }

  private calculateSameCityCost(
    totalWeight: number,
    config: ShippingCalculatorConfig
  ): number {
    // Fixed base + weight-based adjustment for same-city delivery
    return 2.99 + totalWeight * 0.2;
  }

  private async estimateDistance(
    origin: VendorLocation,
    destination: VendorLocation
  ): Promise<number> {
    // Simple estimation based on state zones
    // In production, integrate with Google Maps API or similar

    const stateDistances: Record<string, Record<string, number>> = {
      lagos: {
        abuja: 700,
        "port harcourt": 600,
        enugu: 500,
        kano: 1000,
      },
      abuja: {
        lagos: 700,
        "port harcourt": 600,
        enugu: 400,
        kano: 400,
      },
      // Add more state distances...
    };

    const fromState = origin.province.toLowerCase();
    const toState = destination.province.toLowerCase();

    if (stateDistances[fromState]?.[toState]) {
      return stateDistances[fromState][toState];
    }

    // Fallback: use zone-based estimation
    return this.estimateDistanceByZones(fromState, toState);
  }

  private estimateDistanceByZones(fromState: string, toState: string): number {
    const zones: Record<string, string[]> = {
      south_west: ["lagos", "ogun", "oyo", "osun", "ondo", "ekiti"],
      south_south: ["rivers", "delta", "bayelsa", "akwa ibom", "cross river"],
      south_east: ["enugu", "anambra", "imo", "abia", "ebonyi"],
      north_central: ["abuja", "niger", "kogi", "benue", "plateau"],
      north_east: ["adamawa", "borno", "yobe", "bauchi", "gombe"],
      north_west: ["kano", "kaduna", "katsina", "sokoto", "jigawa"],
    };

    const fromZone = Object.keys(zones).find((zone) =>
      zones[zone].includes(fromState)
    );
    const toZone = Object.keys(zones).find((zone) =>
      zones[zone].includes(toState)
    );

    if (fromZone === toZone) return 200; // Same zone
    if (!fromZone || !toZone) return 500; // Unknown zones

    // Distance between zones
    const zoneDistances: Record<string, Record<string, number>> = {
      south_west: {
        south_south: 400,
        south_east: 500,
        north_central: 600,
        north_east: 900,
        north_west: 800,
      },
      // Add other zone distances...
    };

    return zoneDistances[fromZone]?.[toZone] || 500;
  }

  async getVendorGeo(
    storeId?: string
  ): Promise<{ country: string; province: string; city: string } | null> {
    if (!storeId) return null;

    try {
      const storeRepo = this.container
        .storeRepository as typeof StoreRepository;
      const store = await storeRepo.findOne({ where: { id: storeId } });

      console.log("Fetched store data for storeId", storeId, ":", store);

      if (!store?.metadata) return null;

      const country =
        typeof (store.metadata as any)?.country?.country_iso === "string"
          ? (store.metadata as any).country.country_iso.toUpperCase()
          : "";

      const province =
        typeof (store.metadata as any)?.state?.name === "string"
          ? (store.metadata as any).state.name.toLowerCase()
          : "";

      const city =
        typeof store.metadata.city === "string"
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
    console.log("CustomManualFulfillmentService createFulfillment called");

    const fulfillmentService = this.container
      .fulfillmentService as FulfillmentService;

    const orderService = this.container.orderService as OrderService;
    const orderRepo = this.container.orderRepository as typeof OrderRepository;

    const isChildOrder =
      order.metadata?.type === "childOrder" && order.metadata?.parent;

    if (isChildOrder) {
      const parentOrderId = order.metadata.parent as string;

      // Fetch parent order with related items and fulfillments
      const parentOrder = await orderRepo.findOne({
        where: { id: parentOrderId },
        relations: [
          "items",
          "fulfillments",
          "fulfillments.items",
          "fulfillments.items.item",
          "shipping_methods",
        ],
      });

      if (!parentOrder) {
        throw new Error("Parent order not found");
      }

      // check if parentOrder has a fulfillment already linked to this child order
      const existingFulfillment = this.findExistingFulfillment(
        parentOrder,
        order,
        fulfillment,
        items
      );

      if (existingFulfillment) {
        console.log(
          "Fulfillment already exists for parent order, skipping creation."
        );
        // Sync metadata for both child and parent fulfillments
        await this.updateFulfillmentMetadata(existingFulfillment.id, {
          linked_child_fulfillment_id: fulfillment.id,
          linked_child_order_id: order.id,
        });

        await this.updateFulfillmentMetadata(fulfillment.id, {
          linked_parent_fulfillment_id: existingFulfillment.id,
          linked_parent_order_id: parentOrderId,
        });

        // throw new Error("Fulfillment already exists for parent order");
        return { data: {}, labels: [] };
      } else {
        const parentItemsToFulfill = parentOrder.items.filter((item) =>
          items.some((childItem) => childItem.variant_id === item.variant_id)
        );

        // Extract the shipping method from the parent order
        const shippingMethod = parentOrder.shipping_methods?.[0]; // Select first shipping method (or your logic)

        // Prepare shipping method data
        const shippingMethodData = {
          ...shippingMethod,
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
        await orderService.createFulfillment(
          parentOrder.id,
          newFulfillment.items,
          {
            metadata: newFulfillment.metadata,
          }
        );

        const parentOrderUpdated = await orderRepo.findOne({
          where: { id: parentOrder.id },
          relations: [
            "items",
            "fulfillments",
            "fulfillments.items",
            "fulfillments.items.item",
            "shipping_methods",
          ],
        });

        const existingParentFulfillment = this.findExistingFulfillment(
          parentOrderUpdated,
          order,
          fulfillment,
          items
        );

        // Sync metadata for both child and parent fulfillments
        await this.updateFulfillmentMetadata(existingParentFulfillment.id, {
          linked_child_fulfillment_id: fulfillment.id,
          linked_child_order_id: fulfillment.order_id,
        });

        await this.updateFulfillmentMetadata(fulfillment.id, {
          linked_parent_fulfillment_id: existingParentFulfillment.id,
          linked_parent_order_id: existingParentFulfillment.order_id,
        });
      }

      return {
        data: {},
        labels: [],
      }; // Return empty object as no specific value is expected
    } else {
      console.log("Not a child order, skipping parent fulfillment creation.");
    }

    return {
      data: {},
      labels: [],
    }; // Return empty object as no specific value is expected
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

  async updateFulfillmentMetadata(
    fulfillmentId: string,
    metadata: Record<string, any>
  ) {
    const fulfillmentRepo = this.container
      .fulfillmentRepository as typeof FulfillmentRepository;
    const orderRepo = this.container.orderRepository as typeof OrderRepository;
    const fulfillmentService = this.container
      .fulfillmentService as FulfillmentService;

    // load the fulfillment with its items (so we can reconstruct child items if needed)
    const fulfillment = await fulfillmentRepo.findOne({
      where: { id: fulfillmentId },
      relations: ["items", "items.item"],
    });

    if (!fulfillment) return;

    // load the order that owns this fulfillment (with related fulfillments)
    const order = await orderRepo.findOne({
      where: { id: fulfillment.order_id },
      relations: [
        "items",
        "fulfillments",
        "fulfillments.items",
        "fulfillments.items.item",
        "shipping_methods",
      ],
    });

    // helper to persist metadata merge for a fulfillment instance/id
    const persist = async (f: any, extraMeta: Record<string, any>) => {
      const toSave = await fulfillmentRepo.findOne({ where: { id: f.id } });
      if (!toSave) return;
      toSave.metadata = { ...(toSave.metadata || {}), ...extraMeta };
      await fulfillmentRepo.save(toSave);
    };

    // Build childItems from the current fulfillment's items (if available)
    const childItems: any[] =
      (fulfillment.items || []).map((fi: any) => fi.item).filter(Boolean) || [];

    // If the order is a child order, attempt to find and update the parent fulfillment first
    if (order?.metadata?.type === "childOrder" && order.metadata?.parent) {
      const parentOrderId = order.metadata.parent as string;
      const parentOrder = await orderRepo.findOne({
        where: { id: parentOrderId },
        relations: [
          "items",
          "fulfillments",
          "fulfillments.items",
          "fulfillments.items.item",
          "shipping_methods",
        ],
      });

      if (parentOrder) {
        // Try to locate the corresponding parent fulfillment using existing logic
        const parentFulfillment = this.findExistingFulfillment(
          parentOrder,
          order,
          fulfillment as any,
          childItems
        );

        if (parentFulfillment) {
          // update parent first
          await persist(parentFulfillment, metadata);

          // ensure child points back to parent (merge link metadata)
          await persist(fulfillment, {
            ...(fulfillment.metadata || {}),
            linked_parent_fulfillment_id: parentFulfillment.id,
            linked_parent_order_id: parentFulfillment.order_id,
            ...metadata,
          });

          return;
        }
      }

      // If we couldn't find the parent fulfillment via matching, but the child itself
      // might already reference a parent fulfillment id in its metadata, update that parent
      const linkedParentId = (fulfillment.metadata || {})
        .linked_parent_fulfillment_id as unknown;
      if (typeof linkedParentId === "string" && linkedParentId) {
        const linkedParent = await fulfillmentRepo.findOne({
          where: { id: linkedParentId },
        });
        if (linkedParent) {
          await persist(linkedParent, metadata);
        }
      }

      // finally update child
      await persist(fulfillment, metadata);
      return;
    }

    // If the order is not a child order (treat as parent or standalone),
    // check if this fulfillment links to any child and update the child as well.
    const linkedChildId = (fulfillment.metadata || {})
      .linked_child_fulfillment_id;
    if (typeof linkedChildId === "string" && linkedChildId) {
      const childFulfillment = await fulfillmentRepo.findOne({
        where: { id: linkedChildId },
        relations: ["items", "items.item"],
      });

      if (childFulfillment) {
        // update child (so parent -> child update is possible)
        await persist(childFulfillment, metadata);
      }
    }

    // finally update the provided fulfillment itself
    await persist(fulfillment, metadata);
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
