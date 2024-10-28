import { Lifetime } from "awilix";
import { UserService as MedusaUserService } from "@medusajs/medusa";
import { User } from "../models/user";
import { CreateUserInput as MedusaCreateUserInput } from "@medusajs/medusa/dist/types/user";
import StoreRepository from "../repositories/store";
import WalletRepository from "../repositories/wallet";

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

  async create(user: CreateUserInput, password: string): Promise<User> {
    if (!user.store_id) {
      const storeRepo = this.manager_.withRepository(this.storeRepository_);
      let newStore = storeRepo.create();
      newStore = await storeRepo.save(newStore);
      user.store_id = newStore.id;
    }

    const newUser = await super.create(user, password);

    // Create a wallet for the new user
    const walletRepo = this.manager_.withRepository(this.walletRepository_);
    await walletRepo.createWallet(newUser.id);

    return newUser;
  }
}

export default UserService;
