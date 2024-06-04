import { Lifetime } from "awilix";
import {
  OrderService as MedusaOrderService,
  Order,
  User,
  FindConfig,
  Selector,
} from "@medusajs/medusa";

class OrderService extends MedusaOrderService {
  static LIFE_TIME = Lifetime.SCOPED;
  protected readonly loggedInUser_: User | null;
  container: any;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments)

    try {
      this.loggedInUser_ = container.loggedInUser;
      this.container = container;
    } catch (e) {
      // avoid errors when the backend first runs
    }
  }

  async retrieve(orderId: string, config?: FindConfig<Order>): Promise<Order> {
    
    if(this.loggedInUser_){
      config.relations = [
        ...(config.relations || []),
        'store'
      ]
      config.select = [
        ...(config.select || []),
        'store_id'
      ]
    }
    
    const order = await super.retrieve(orderId, config);
    
    if (this.loggedInUser_ && this.loggedInUser_?.store_id && order.store_id !== this.loggedInUser_.store_id) {
      // Throw error if you don't want an order to be accessible to other stores
      throw new Error('Order does not exist in store.');
    }

    return order
  }

  async list(
    selector: Selector<Order>,
    config?: FindConfig<Order>
  ): Promise<Order[]> {
    // Your existing logic for listing orders
    if (this.loggedInUser_ && this.loggedInUser_.store_id) {
      selector["store_id"] = this.loggedInUser_.store_id;
    }

    config.select.push("store_id");

    config.relations = config.relations ?? [];
    config.relations.push("children", "parent", "store");

    return await super.list(selector, config);
  }


  async listAndCount(selector: Selector<Order>, config?: FindConfig<Order>): Promise<[Order[], number]> {
    // Your existing logic for listing orders
    if (this.loggedInUser_ && this.loggedInUser_.store_id) {
      selector["store_id"] = this.loggedInUser_.store_id;
    }

    config.select.push("store_id");

    config.relations = config.relations ?? [];
    config.relations.push("children", "parent", "store");

    return await super.listAndCount(selector, config)
  }

}

export default OrderService;
