import { Lifetime } from "awilix";
import { OrderService as MedusaOrderService, Order, User, FindConfig, Selector } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { StoreRepository } from "../repositories/store";
// import { CreateOrderInput as MedusaCreateOrderInput, AdminListOrdersSelector as MedusaOrderSelector } from "@medusajs/medusa/dist/types/orders";



class OrderService extends MedusaOrderService {
  static LIFE_TIME = Lifetime.SCOPED;
  protected readonly loggedInUser_: User | null;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments)
    

    try {
        this.loggedInUser_ = container.loggedInUser;
    } catch (e) {
        // avoid errors when backend first runs
    }
  }

  async list(selector: Selector<Order>, config?: FindConfig<Order>): Promise<Order[]> {
    if (this.loggedInUser_ && this.loggedInUser_.store_id) {
      selector["store_id"] = this.loggedInUser_.store_id;
    }

    config.select.push("store_id");

    config.relations = config.relations ?? [];

    config.relations.push("children", "parent", "store");

    return await super.list(selector, config)
  }

}

export default OrderService;
