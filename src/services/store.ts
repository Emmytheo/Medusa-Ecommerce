import { Lifetime } from "awilix"
import { 
  FindConfig,
  StoreService as MedusaStoreService, Store, User,
} from "@medusajs/medusa"

class StoreService extends MedusaStoreService {
  static LIFE_TIME = Lifetime.SCOPED
  protected readonly loggedInUser_: User | null
  protected readonly container_: any

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments)

    this.container_ = container
    try {
      this.loggedInUser_ = container.loggedInUser
    } catch (e) {
      // avoid errors when backend first runs
    }
  }

  async retrieve(config?: FindConfig<Store>): Promise<Store> {
    let user: any = this.loggedInUser_
    if (!user && this.container_) {
      try {
        if (typeof this.container_.hasRegistration === "function" && this.container_.hasRegistration("loggedInUser")) {
          user = this.container_.resolve("loggedInUser")
        }
      } catch (e) {}
    }

    if (user?.store_id) {
      return this.retrieveForUser(user.store_id, config)
    }

    return super.retrieve(config);
  }

  async retrieveForUser(storeId: string, config?: FindConfig<Store>) {
    const storeRepo = this.manager_.withRepository(this.storeRepository_);
    const store = await storeRepo.findOne({
        ...config,
        relations: [
          ...(config?.relations || []),
          'members'
        ],
        where: {
          id: storeId
        },
    });

    if (!store) {
        return super.retrieve(config);
    }

    return store
  }

  async retrieveForLoggedInUser (config?: FindConfig<Store>) {
    if (this.loggedInUser_?.store_id) {
      return this.retrieveForUser(this.loggedInUser_.store_id, config);
    }
    return super.retrieve(config);
  }

  async update(data: any): Promise<Store> {
    if (!data.default_sales_channel_id) {
      data.default_sales_channel_id = "sc_01HHMEQR8YTK2DZ7PCR6DES1R4";
    }
    return super.update(data);
  }
}

export default StoreService