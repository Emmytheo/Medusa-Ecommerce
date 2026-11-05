import { Lifetime } from "awilix";
import {
  ProductService as MedusaProductService,
  Product,
  User,
} from "@medusajs/medusa";
import {
  CreateProductInput as MedusaCreateProductInput,
  FindProductConfig,
  ProductSelector as MedusaProductSelector,
} from "@medusajs/medusa/dist/types/product";

type ProductSelector = {
  store_id?: string;
} & MedusaProductSelector;

type CreateProductInput = {
  store_id?: string;
} & MedusaCreateProductInput;

class ProductService extends MedusaProductService {
  static LIFE_TIME = Lifetime.SCOPED;
  protected readonly loggedInUser_: User | null;
  protected readonly container_: any;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments);
    this.container_ = container;

    try {
      this.loggedInUser_ = container.loggedInUser;
    } catch (e) {
      // avoid errors when backend first runs
    }
  }

  getLoggedInUser(): User | null {
    let user: any = this.loggedInUser_;
    if (!user && this.container_) {
      try {
        if (typeof this.container_.hasRegistration === "function" && this.container_.hasRegistration("loggedInUser")) {
          user = this.container_.resolve("loggedInUser");
        }
      } catch (e) {}
    }
    return user || null;
  }

  async list(
    selector: ProductSelector,
    config?: FindProductConfig
  ): Promise<Product[]> {
    const user = this.getLoggedInUser();
    if (!selector.store_id && user?.store_id) {
      const userRole = (user.role || "").toLowerCase();
      if (userRole !== "admin") {
        selector.store_id = user.store_id;
      }
    }

    config = config || ({} as FindProductConfig);
    config.select = config.select || [];
    config.select.push("store_id");

    config.relations = config.relations || [];
    config.relations.push("store");

    return await super.list(selector, config);
  }

  async listAndCount(
    selector: ProductSelector,
    config?: FindProductConfig
  ): Promise<[Product[], number]> {
    const user = this.getLoggedInUser();
    if (!selector.store_id && user?.store_id) {
      const userRole = (user.role || "").toLowerCase();
      if (userRole !== "admin") {
        selector.store_id = user.store_id;
      }
    }
    config ??= {};
    config.relations ??= [];
    config.relations.push("store");

    return await super.listAndCount(selector, config);
  }

  async retrieve(
    productId: string,
    config?: FindProductConfig
  ): Promise<Product> {
    config ??= {};
    config.relations ??= [];
    config.relations.push("store");

    const product = await super.retrieve(productId, config);
    const user = this.getLoggedInUser();

    if (
      product.store?.id &&
      user?.store_id &&
      product.store.id !== user.store_id
    ) {
      const userRole = (user.role || "").toLowerCase();
      if (userRole !== "admin") {
        throw new Error("Product does not exist in store.");
      }
    }

    return product;
  }

  async create(productObject: CreateProductInput): Promise<Product> {
    const user = this.getLoggedInUser();
    if (!productObject.store_id && user?.store_id) {
      productObject.store_id = user.store_id;
    }
    if (!productObject.store_id) {
      throw new Error("Store ID is required to create a product.");
    }
    if (user?.store_id && productObject.store_id !== user.store_id) {
      const userRole = (user.role || "").toLowerCase();
      if (userRole !== "admin") {
        throw new Error("You can only create products for your own store.");
      }
    }
    if (!productObject.title) {
      throw new Error("Product title is required.");
    }

    // Ensure storefront sales channel is always included so vendor products appear live online
    const defaultStorefrontSalesChannelId = "sc_01HHMEQR8YTK2DZ7PCR6DES1R4";
    const existingChannels = (productObject as any).sales_channels || [];
    const hasStorefrontChannel = existingChannels.some(
      (sc: any) => sc.id === defaultStorefrontSalesChannelId
    );
    if (!hasStorefrontChannel) {
      (productObject as any).sales_channels = [
        ...existingChannels,
        { id: defaultStorefrontSalesChannelId },
      ];
    }

    return await super.create(productObject);
  }
}

export default ProductService;
