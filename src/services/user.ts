import { Lifetime } from "awilix";
import { UserService as MedusaUserService, FindConfig } from "@medusajs/medusa";
import { User } from "../models/user";
import { CreateUserInput as MedusaCreateUserInput, FilterableUserProps } from "@medusajs/medusa/dist/types/user";
import StoreRepository from "../repositories/store";
import WalletRepository from "../repositories/wallet";
import { MedusaError } from "@medusajs/utils";

type CreateUserInput = {
  store_id?: string;
} & MedusaCreateUserInput;

class UserService extends MedusaUserService {
  static LIFE_TIME = Lifetime.SCOPED;
  protected readonly loggedInUser_: User | null;
  protected readonly storeRepository_: typeof StoreRepository;
  protected readonly walletRepository_: typeof WalletRepository;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments);
    this.storeRepository_ = container.storeRepository;
    this.walletRepository_ = container.walletRepository;

    try {
      this.loggedInUser_ = container.loggedInUser;
    } catch (e) {
      // Avoid errors when backend first runs
    }
  }

  async list(
    selector: FilterableUserProps & { store_id?: string } = {},
    config: FindConfig<User> = {}
  ): Promise<User[]> {
    if (!selector.store_id && this.loggedInUser_?.store_id) {
      selector.store_id = this.loggedInUser_.store_id;
    }
    return await super.list(selector, config as any);
  }

  async listAndCount(
    selector: FilterableUserProps & { store_id?: string } = {},
    config: FindConfig<User> = {}
  ): Promise<[User[], number]> {
    if (!selector.store_id && this.loggedInUser_?.store_id) {
      selector.store_id = this.loggedInUser_.store_id;
    }
    return await super.listAndCount(selector, config as any);
  }

  async retrieve(userId: string, config: FindConfig<User> = {}): Promise<User> {
    if (userId === "me") {
      const id = this.loggedInUser_?.id;
      if (!id) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "No logged in user found"
        );
      }
      return await super.retrieve(id, config);
    }
    return await super.retrieve(userId, config);
  }

  async create(user: CreateUserInput, password: string): Promise<User> {
    if (!user.store_id) {
      const storeRepo = this.manager_.withRepository(this.storeRepository_);
      let newStore = storeRepo.create();
      newStore = await storeRepo.save(newStore);
      user.store_id = newStore.id;
    }

    const newUser = await super.create(user, password);

    // // Create a wallet for the new user
    // const walletRepo = this.manager_.withRepository(this.walletRepository_);
    // await walletRepo.createWallet(newUser.id);

    return newUser;
  }
}

export default UserService;

