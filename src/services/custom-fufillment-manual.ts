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
  fallback?: boolean;
}

export interface LiveShippingSettings {
  id: string;
  base_currency: string;
  default_weight_kg: number;
  same_city_base_ngn: number;
  same_city_per_kg_ngn: number;
  default_intra_state_ngn: number;
  default_inter_state_ngn: number;
  default_weight_per_kg_ngn: number;
  international_base_ngn: number;
  international_per_kg_ngn: number;
  free_shipping_threshold_ngn: number;
  handling_fee_ngn: number;
  speed_multipliers: Record<string, number>;
  international_zones: Record<string, { base_ngn: number; per_kg_ngn: number; eta?: string }>;
}

export interface StateRuleEntry {
  id?: string;
  origin_state: string;
  logistics_org_id?: string | null;
  base_fare_ngn: number;
  weight_cost_per_kg_ngn: number;
  state_fares: Record<string, Record<string, number>>;
  active: boolean;
}

interface LiveShippingCache {
  loadedAt: number;
  settings: LiveShippingSettings;
  globalMatrix: Record<string, StateRuleEntry>;
  orgMatrices: Record<string, Record<string, StateRuleEntry>>;
  fxRates: Record<string, number>;
}

const DEFAULT_SETTINGS: LiveShippingSettings = {
  id: "default",
  base_currency: "NGN",
  default_weight_kg: 1.0,
  same_city_base_ngn: 1500,
  same_city_per_kg_ngn: 150,
  default_intra_state_ngn: 2500,
  default_inter_state_ngn: 4500,
  default_weight_per_kg_ngn: 60,
  international_base_ngn: 35000,
  international_per_kg_ngn: 8500,
  free_shipping_threshold_ngn: 0,
  handling_fee_ngn: 0,
  speed_multipliers: { standard: 1.0, express: 1.4, overnight: 1.8 },
  international_zones: {
    GH: { base_ngn: 18000, per_kg_ngn: 4500, eta: "2-4 business days" },
    GB: { base_ngn: 38000, per_kg_ngn: 9500, eta: "4-7 business days" },
    US: { base_ngn: 42000, per_kg_ngn: 10500, eta: "5-8 business days" },
    CA: { base_ngn: 44000, per_kg_ngn: 10500, eta: "5-8 business days" },
    EU: { base_ngn: 38000, per_kg_ngn: 9500, eta: "4-7 business days" },
  },
};

const EU_COUNTRIES = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","CH","NO"
]);

const FALLBACK_FX_USD: Record<string, number> = {
  USD: 1,
  NGN: 1600,
  GHS: 15.5,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.38,
  KES: 129,
  ZAR: 18.2,
};

let _shippingCache: LiveShippingCache | null = null;
const CACHE_TTL_MS = 30_000;

export function invalidateShippingRulesCache(): void {
  _shippingCache = null;
}

const buildFulfillmentItems = (items: LineItem[]): FulfillmentItem[] => {
  return items.map((item) => ({
    item_id: item.id,
    quantity: item.quantity,
    fulfillment_id: "",
    fulfillment: null,
    item: item,
  }));
};

class CustomManualFulfillmentService extends AbstractFulfillmentService {
  static identifier = "custom-fulfillment-manual";

  constructor(container, options) {
    super(container);
  }

  public readonly stateFareMatrix = {
    ...shippingRules,
  };

  public static invalidateCache(): void {
    invalidateShippingRulesCache();
  }

  public async loadLiveConfig(forceRefresh = false): Promise<LiveShippingCache> {
    if (!forceRefresh && _shippingCache && Date.now() - _shippingCache.loadedAt < CACHE_TTL_MS) {
      return _shippingCache;
    }

    const globalMatrix: Record<string, StateRuleEntry> = {};
    // Seed fallback from static JSON first
    for (const [stateName, entry] of Object.entries((shippingRules as any).fare_matrix || {})) {
      const e = entry as any;
      globalMatrix[this.normalizeStateName(stateName)] = {
        origin_state: this.normalizeStateName(stateName),
        logistics_org_id: null,
        base_fare_ngn: Number(e.base_fare) || 2500,
        weight_cost_per_kg_ngn: Number(e.weight_cost_per_kg) || 60,
        state_fares: e.state_fares || {},
        active: true,
      };
    }

    let settings: LiveShippingSettings = { ...DEFAULT_SETTINGS };
    const orgMatrices: Record<string, Record<string, StateRuleEntry>> = {};
    const fxRates: Record<string, number> = { ...FALLBACK_FX_USD };

    const manager = (this.container as any)?.manager;
    if (manager?.query) {
      try {
        const sRows = await manager.query(
          `SELECT * FROM public.shipping_settings WHERE id = 'default' LIMIT 1`
        );
        if (Array.isArray(sRows) && sRows.length > 0) {
          const row = sRows[0];
          settings = {
            id: row.id || "default",
            base_currency: row.base_currency || "NGN",
            default_weight_kg: Number(row.default_weight_kg) || 1.0,
            same_city_base_ngn: Number(row.same_city_base_ngn) || 1500,
            same_city_per_kg_ngn: Number(row.same_city_per_kg_ngn) || 150,
            default_intra_state_ngn: Number(row.default_intra_state_ngn) || 2500,
            default_inter_state_ngn: Number(row.default_inter_state_ngn) || 4500,
            default_weight_per_kg_ngn: Number(row.default_weight_per_kg_ngn) || 60,
            international_base_ngn: Number(row.international_base_ngn) || 35000,
            international_per_kg_ngn: Number(row.international_per_kg_ngn) || 8500,
            free_shipping_threshold_ngn: Number(row.free_shipping_threshold_ngn) || 0,
            handling_fee_ngn: Number(row.handling_fee_ngn) || 0,
            speed_multipliers:
              row.speed_multipliers && typeof row.speed_multipliers === "object"
                ? row.speed_multipliers
                : DEFAULT_SETTINGS.speed_multipliers,
            international_zones:
              row.international_zones && typeof row.international_zones === "object"
                ? row.international_zones
                : DEFAULT_SETTINGS.international_zones,
          };
        }
      } catch (_) {}

      try {
        const rRows = await manager.query(
          `SELECT id, origin_state, logistics_org_id, base_fare_ngn, weight_cost_per_kg_ngn, state_fares, active
           FROM public.shipping_rate_rules
           WHERE active = true`
        );
        if (Array.isArray(rRows)) {
          for (const row of rRows) {
            const norm = this.normalizeStateName(row.origin_state);
            const entry: StateRuleEntry = {
              id: row.id,
              origin_state: norm,
              logistics_org_id: row.logistics_org_id || null,
              base_fare_ngn: Number(row.base_fare_ngn) || 2500,
              weight_cost_per_kg_ngn: Number(row.weight_cost_per_kg_ngn) || 60,
              state_fares: row.state_fares && typeof row.state_fares === "object" ? row.state_fares : {},
              active: Boolean(row.active),
            };
            if (entry.logistics_org_id) {
              if (!orgMatrices[entry.logistics_org_id]) {
                orgMatrices[entry.logistics_org_id] = {};
              }
              orgMatrices[entry.logistics_org_id][norm] = entry;
            } else {
              globalMatrix[norm] = entry;
            }
          }
        }
      } catch (_) {}

      try {
        const fxRows = await manager.query(
          `SELECT currency_code, average_rate FROM public.exchange_rate`
        );
        if (Array.isArray(fxRows)) {
          for (const row of fxRows) {
            const code = String(row.currency_code || "").toUpperCase();
            const rate = Number(row.average_rate);
            if (code && rate > 0) {
              fxRates[code] = rate;
            }
          }
        }
      } catch (_) {}
    }

    _shippingCache = {
      loadedAt: Date.now(),
      settings,
      globalMatrix,
      orgMatrices,
      fxRates,
    };
    return _shippingCache;
  }

  public convertNgnToCurrencyMinor(
    ngnAmountMajor: number,
    currencyCode: string,
    fxRates: Record<string, number>
  ): { minor: number; major: number; fxRateFromNgn: number } {
    const code = (currencyCode || "ngn").toUpperCase();
    if (ngnAmountMajor <= 0) {
      return { minor: 0, major: 0, fxRateFromNgn: 1 };
    }
    if (code === "NGN") {
      const major = Math.round(ngnAmountMajor);
      return { minor: Math.round(major * 100), major, fxRateFromNgn: 1 };
    }

    const ngnPerUsd = fxRates.NGN || FALLBACK_FX_USD.NGN;
    const targetPerUsd = code === "USD" ? 1 : fxRates[code] || FALLBACK_FX_USD[code] || 1;
    const fxRateFromNgn = targetPerUsd / ngnPerUsd;
    const rawMajor = ngnAmountMajor * fxRateFromNgn;
    const major = Math.round(rawMajor * 100) / 100;
    return {
      minor: Math.max(100, Math.round(major * 100)),
      major,
      fxRateFromNgn,
    };
  }

  public convertMinorToNgnMajor(
    amountMinor: number,
    currencyCode: string,
    fxRates: Record<string, number>
  ): number {
    const code = (currencyCode || "ngn").toUpperCase();
    const major = (Number(amountMinor) || 0) / 100;
    if (code === "NGN") return major;
    const ngnPerUsd = fxRates.NGN || FALLBACK_FX_USD.NGN;
    const sourcePerUsd = code === "USD" ? 1 : fxRates[code] || FALLBACK_FX_USD[code] || 1;
    return (major / sourcePerUsd) * ngnPerUsd;
  }

  private resolveRuleForState(
    stateName: string,
    live: LiveShippingCache,
    logisticsOrgId?: string | null
  ): StateRuleEntry | null {
    const norm = this.normalizeStateName(stateName);
    if (logisticsOrgId && live.orgMatrices[logisticsOrgId]?.[norm]) {
      return live.orgMatrices[logisticsOrgId][norm];
    }
    return live.globalMatrix[norm] || null;
  }

  private computeRouteNgn(
    origin: VendorLocation,
    destination: VendorLocation,
    weightKg: number,
    speed: string,
    live: LiveShippingCache,
    logisticsOrgId?: string | null
  ): {
    scenario: "same-city" | "intra-state" | "inter-state" | "international";
    zone: string;
    baseNgn: number;
    weightNgn: number;
    handlingNgn: number;
    multiplier: number;
    totalNgn: number;
    eta: string;
  } {
    const { settings } = live;
    const scenario = this.determineShippingScenario(destination, origin).type;
    const effectiveWeight = Math.max(weightKg > 0 ? weightKg : settings.default_weight_kg, 0.1);
    const mult =
      Number(settings.speed_multipliers?.[speed]) ||
      (speed === "express" ? 1.4 : speed === "overnight" ? 1.8 : 1.0);

    let baseNgn = settings.default_inter_state_ngn;
    let weightNgn = effectiveWeight * settings.default_weight_per_kg_ngn;
    let zone: string = scenario;
    let eta =
      speed === "overnight"
        ? "Next business day"
        : speed === "express"
          ? "1–2 business days"
          : "2–5 business days";

    if (scenario === "international") {
      const destIso = (destination.country || "").toUpperCase();
      const zoneCfg =
        settings.international_zones?.[destIso] ||
        (EU_COUNTRIES.has(destIso) ? settings.international_zones?.EU : null);
      baseNgn = zoneCfg ? Number(zoneCfg.base_ngn) : settings.international_base_ngn;
      const perKg = zoneCfg ? Number(zoneCfg.per_kg_ngn) : settings.international_per_kg_ngn;
      weightNgn = effectiveWeight * perKg;
      zone = zoneCfg ? `international_${destIso}` : "international";
      eta =
        speed === "overnight"
          ? "2–3 business days (Air Express)"
          : speed === "express"
            ? "3–5 business days"
            : zoneCfg?.eta || "5–8 business days";
    } else if (scenario === "same-city") {
      baseNgn = settings.same_city_base_ngn;
      weightNgn = effectiveWeight * settings.same_city_per_kg_ngn;
      zone = "same_city";
      eta =
        speed === "overnight"
          ? "Same day (4–6 hrs)"
          : speed === "express"
            ? "Same day / Next day"
            : "1–2 business days";
    } else if (scenario === "intra-state") {
      const rule = this.resolveRuleForState(origin.province, live, logisticsOrgId);
      baseNgn = rule ? rule.base_fare_ngn : settings.default_intra_state_ngn;
      const perKg = rule ? rule.weight_cost_per_kg_ngn : settings.default_weight_per_kg_ngn;
      weightNgn = effectiveWeight * perKg;
      zone = "intra_state";
      eta =
        speed === "overnight"
          ? "Same / Next day"
          : speed === "express"
            ? "1 business day"
            : "1–3 business days";
    } else {
      // inter-state
      const originRule = this.resolveRuleForState(origin.province, live, logisticsOrgId);
      const destNorm = this.normalizeStateName(destination.province);
      if (originRule) {
        const matched = this.findStateFareWithZone(originRule.state_fares, destNorm);
        if (matched) {
          baseNgn = matched.fare;
          zone = matched.zone;
        } else {
          // Try reverse lookup if destination has origin in its matrix
          const reverseRule = this.resolveRuleForState(destNorm, live, logisticsOrgId);
          const revMatched = reverseRule
            ? this.findStateFareWithZone(reverseRule.state_fares, this.normalizeStateName(origin.province))
            : null;
          if (revMatched) {
            baseNgn = revMatched.fare;
            zone = revMatched.zone;
          } else {
            const extremeFares = originRule.state_fares?.extreme;
            if (extremeFares && Object.keys(extremeFares).length > 0) {
              baseNgn = Number(Object.values(extremeFares)[0]) || settings.default_inter_state_ngn;
              zone = "far";
            } else {
              baseNgn = originRule.base_fare_ngn + 2500;
              zone = "mid";
            }
          }
        }
        weightNgn = effectiveWeight * originRule.weight_cost_per_kg_ngn;
      } else {
        baseNgn = settings.default_inter_state_ngn;
        weightNgn = effectiveWeight * settings.default_weight_per_kg_ngn;
        zone = "inter_state";
      }
    }

    const handlingNgn = Number(settings.handling_fee_ngn) || 0;
    const totalNgn = Math.round((baseNgn + weightNgn + handlingNgn) * mult);

    return {
      scenario,
      zone,
      baseNgn: Math.round(baseNgn),
      weightNgn: Math.round(weightNgn),
      handlingNgn: Math.round(handlingNgn),
      multiplier: mult,
      totalNgn,
      eta,
    };
  }

  async estimateShipping(params: {
    cart?: Cart | null;
    origin_state?: string;
    origin_country?: string;
    origin_city?: string;
    destination_state?: string;
    destination_country?: string;
    destination_city?: string;
    weight_kg?: number;
    currency_code?: string;
    subtotal_minor?: number;
    logistics_org_id?: string | null;
  }) {
    const live = await this.loadLiveConfig();
    const cart = params.cart || null;

    const currencyCode = (
      params.currency_code ||
      cart?.region?.currency_code ||
      "ngn"
    ).toLowerCase();

    const destCountry = (
      params.destination_country ||
      cart?.shipping_address?.country_code ||
      (currencyCode === "ghs" ? "GH" : currencyCode === "usd" ? "US" : currencyCode === "eur" ? "DE" : "NG")
    ).toUpperCase();

    const destProvince = this.normalizeStateName(
      params.destination_state || cart?.shipping_address?.province || ""
    );
    const destCity = (params.destination_city || cart?.shipping_address?.city || "").trim().toLowerCase();

    const destination: VendorLocation = {
      country: destCountry,
      province: destProvince,
      city: destCity,
    };

    const speeds: Array<"standard" | "express" | "overnight"> = ["standard", "express", "overnight"];
    const vendorLegs: Array<{
      store_id: string;
      origin: VendorLocation;
      weight_kg: number;
      scenario: string;
      zone: string;
      standard_ngn: number;
      express_ngn: number;
      overnight_ngn: number;
    }> = [];

    let totalWeightKg = 0;

    if (cart && Array.isArray(cart.items) && cart.items.length > 0) {
      const itemsByVendor: Record<string, LineItem[]> = {};
      for (const item of cart.items) {
        const storeId = (item.variant?.product as any)?.store_id || "platform_default";
        if (!itemsByVendor[storeId]) itemsByVendor[storeId] = [];
        itemsByVendor[storeId].push(item);
      }

      for (const [storeId, items] of Object.entries(itemsByVendor)) {
        const origin =
          storeId === "platform_default"
            ? { country: "NG", province: "Lagos", city: "lagos", fallback: true }
            : (await this.getVendorGeo(storeId)) || {
                country: "NG",
                province: "Lagos",
                city: "lagos",
                fallback: true,
              };
        const w = this.calculateTotalWeight(items, live.settings.default_weight_kg);
        totalWeightKg += w;

        const std = this.computeRouteNgn(origin, destination, w, "standard", live, params.logistics_org_id);
        const exp = this.computeRouteNgn(origin, destination, w, "express", live, params.logistics_org_id);
        const ovn = this.computeRouteNgn(origin, destination, w, "overnight", live, params.logistics_org_id);

        vendorLegs.push({
          store_id: storeId,
          origin,
          weight_kg: Math.round(w * 100) / 100,
          scenario: std.scenario,
          zone: std.zone,
          standard_ngn: std.totalNgn,
          express_ngn: exp.totalNgn,
          overnight_ngn: ovn.totalNgn,
        });
      }
    } else {
      const origin: VendorLocation = {
        country: (params.origin_country || "NG").toUpperCase(),
        province: this.normalizeStateName(params.origin_state || "Lagos"),
        city: (params.origin_city || "").trim().toLowerCase(),
      };
      const w = Number(params.weight_kg) > 0 ? Number(params.weight_kg) : live.settings.default_weight_kg;
      totalWeightKg = w;
      const std = this.computeRouteNgn(origin, destination, w, "standard", live, params.logistics_org_id);
      const exp = this.computeRouteNgn(origin, destination, w, "express", live, params.logistics_org_id);
      const ovn = this.computeRouteNgn(origin, destination, w, "overnight", live, params.logistics_org_id);

      vendorLegs.push({
        store_id: "direct_quote",
        origin,
        weight_kg: Math.round(w * 100) / 100,
        scenario: std.scenario,
        zone: std.zone,
        standard_ngn: std.totalNgn,
        express_ngn: exp.totalNgn,
        overnight_ngn: ovn.totalNgn,
      });
    }

    const subtotalMinor =
      params.subtotal_minor ??
      (cart
        ? (cart.items || []).reduce((acc, it) => acc + (Number(it.unit_price) || 0) * (it.quantity || 1), 0)
        : 0);
    const subtotalNgn = this.convertMinorToNgnMajor(subtotalMinor, currencyCode, live.fxRates);
    const qualifiesFreeShipping =
      live.settings.free_shipping_threshold_ngn > 0 &&
      subtotalNgn >= live.settings.free_shipping_threshold_ngn;

    const options: Record<string, any> = {};
    for (const sp of speeds) {
      const sumNgn = vendorLegs.reduce((acc, leg) => {
        if (sp === "express") return acc + leg.express_ngn;
        if (sp === "overnight") return acc + leg.overnight_ngn;
        return acc + leg.standard_ngn;
      }, 0);
      const freeApplied = sp === "standard" && qualifiesFreeShipping;
      const finalNgn = freeApplied ? 0 : sumNgn;
      const converted = this.convertNgnToCurrencyMinor(finalNgn, currencyCode, live.fxRates);
      const primaryOrigin = vendorLegs[0]?.origin || { country: "NG", province: "Lagos", city: "lagos" };
      const sample = this.computeRouteNgn(primaryOrigin, destination, totalWeightKg, sp, live, params.logistics_org_id);

      options[sp] = {
        speed: sp,
        amount_ngn: finalNgn,
        amount_minor: converted.minor,
        amount_major: converted.major,
        currency_code: currencyCode,
        multiplier: sample.multiplier,
        eta: sample.eta,
        free_shipping_applied: freeApplied,
      };
    }

    return {
      currency_code: currencyCode,
      fx_rate_ngn_to_target: this.convertNgnToCurrencyMinor(1000, currencyCode, live.fxRates).fxRateFromNgn,
      total_weight_kg: Math.round(totalWeightKg * 100) / 100,
      origin: vendorLegs[0]?.origin || { country: "NG", province: "Lagos", city: "lagos" },
      destination,
      scenario: vendorLegs[0]?.scenario || "inter-state",
      zone: vendorLegs[0]?.zone || "inter_state",
      free_shipping_threshold_ngn: live.settings.free_shipping_threshold_ngn,
      vendor_count: vendorLegs.length,
      vendor_breakdown: vendorLegs,
      options,
    };
  }

  async calculatePrice(
    optionData: any,
    data: any,
    cart: Cart
  ): Promise<number> {
    try {
      const speed = String(
        optionData?.speed ||
          data?.speed ||
          (String(optionData?.name || "").toLowerCase().includes("overnight")
            ? "overnight"
            : String(optionData?.name || "").toLowerCase().includes("express")
              ? "express"
              : "standard")
      ).toLowerCase();

      const estimate = await this.estimateShipping({ cart });
      const chosen = estimate.options[speed] || estimate.options.standard;
      return Math.max(0, Math.round(Number(chosen?.amount_minor) || 0));
    } catch (err: any) {
      console.error("[CustomManualFulfillmentService] calculatePrice error:", err?.message || err);
      const live = await this.loadLiveConfig();
      const currency = cart?.region?.currency_code || "ngn";
      return this.convertNgnToCurrencyMinor(live.settings.default_inter_state_ngn, currency, live.fxRates).minor;
    }
  }

  private findStateFareWithZone(
    stateFares: any,
    targetState: string
  ): { fare: number; zone: string } | null {
    if (!stateFares || !targetState) return null;
    const zones = ["neighboring", "near", "mid", "far", "extreme"];
    const targetLower = targetState.toLowerCase();

    for (const zone of zones) {
      const bucket = stateFares[zone];
      if (!bucket || typeof bucket !== "object") continue;
      if (bucket[targetState] !== undefined) {
        return { fare: Number(bucket[targetState]), zone };
      }
      for (const [k, v] of Object.entries(bucket)) {
        if (this.normalizeStateName(k).toLowerCase() === targetLower) {
          return { fare: Number(v), zone };
        }
      }
    }

    return null;
  }

  public normalizeStateName(stateName: string): string {
    if (!stateName) return "";

    let cleaned = String(stateName)
      .trim()
      .replace(/[-_]+/g, " ")
      .replace(/\s+state\.?$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    const lower = cleaned.toLowerCase();
    if (
      lower === "fct" ||
      lower === "f.c.t" ||
      lower === "f.c.t." ||
      lower.includes("federal capital") ||
      lower.includes("abuja")
    ) {
      return "Federal Capital Territory";
    }

    return cleaned
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  private determineShippingScenario(
    destination: VendorLocation,
    origin: VendorLocation
  ): { type: "international" | "inter-state" | "intra-state" | "same-city" } {
    const destCountry = (destination.country || "NG").toUpperCase();
    const origCountry = (origin.country || "NG").toUpperCase();

    if (destCountry !== origCountry) {
      return { type: "international" };
    }

    const destState = this.normalizeStateName(destination.province).toLowerCase();
    const origState = this.normalizeStateName(origin.province).toLowerCase();

    if (!destState || !origState) {
      return { type: "inter-state" };
    }

    if (destState !== origState) {
      return { type: "inter-state" };
    }

    const destCity = (destination.city || "").trim().toLowerCase();
    const origCity = (origin.city || "").trim().toLowerCase();
    if (destCity && origCity && destCity === origCity) {
      return { type: "same-city" };
    }

    return { type: "intra-state" };
  }

  private calculateTotalWeight(items: LineItem[], defaultWeightKg = 1.0): number {
    return items.reduce((acc, item) => {
      const variant = (item.variant || {}) as any;
      const product = (variant.product || {}) as any;
      const qty = Math.max(1, Number(item.quantity) || 1);

      let unitKg = 0;
      const explicitKg = Number(
        variant.weight_in_kg ??
          variant.metadata?.weight_kg ??
          product.metadata?.weight_kg ??
          0
      );
      if (explicitKg > 0) {
        unitKg = explicitKg;
      } else {
        const rawWeight = Number(variant.weight ?? product.weight ?? 0);
        if (rawWeight > 0) {
          // Medusa core stores weight in grams (e.g., 400g = 0.4kg); small numbers (<50) are treated as kg
          unitKg = rawWeight >= 50 ? rawWeight / 1000 : rawWeight;
        } else {
          unitKg = defaultWeightKg;
        }
      }

      return acc + unitKg * qty;
    }, 0);
  }

  async getVendorGeo(
    storeId?: string
  ): Promise<VendorLocation | null> {
    if (!storeId) return null;

    try {
      const storeRepo = this.container
        .storeRepository as typeof StoreRepository;
      const store = await storeRepo.findOne({ where: { id: storeId } });

      if (!store?.metadata) return null;
      const meta = store.metadata as any;

      let country = "";
      if (typeof meta?.country === "string") {
        country = meta.country.length === 2 ? meta.country.toUpperCase() : (meta.country.toLowerCase().includes("ghana") ? "GH" : "NG");
      } else if (typeof meta?.country?.country_iso === "string") {
        country = meta.country.country_iso.toUpperCase();
      } else if (typeof meta?.country_code === "string") {
        country = meta.country_code.toUpperCase();
      }

      let rawProvince = "";
      if (typeof meta?.state === "string") {
        rawProvince = meta.state;
      } else if (typeof meta?.state?.name === "string") {
        rawProvince = meta.state.name;
      } else if (typeof meta?.market?.state === "string") {
        rawProvince = meta.market.state;
      } else if (typeof meta?.province === "string") {
        rawProvince = meta.province;
      }

      const province = this.normalizeStateName(rawProvince);

      const city = (
        (typeof meta?.city === "string" && meta.city) ||
        (typeof meta?.market?.city === "string" && meta.market.city) ||
        (typeof meta?.lga === "string" && meta.lga) ||
        ""
      )
        .trim()
        .toLowerCase();

      if (!country && province) {
        country = "NG";
      }

      if (!country && !province && !city) return null;

      return {
        country: country || "NG",
        province: province || "Lagos",
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
        speed: "standard",
      },
      {
        id: "custom-fulfillment-manual",
        speed: "express",
      },
      {
        id: "custom-fulfillment-manual",
        speed: "overnight",
      },
      {
        id: "custom-fulfillment-manual-return",
        speed: "standard",
        is_return: true,
      },
    ];
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    cart: Cart
  ): Promise<Record<string, unknown>> {
    return {
      ...optionData,
      ...data,
      id: (data?.id || optionData?.id || "custom-fulfillment-manual") as string,
      speed: (data?.speed || optionData?.speed || "standard") as string,
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
