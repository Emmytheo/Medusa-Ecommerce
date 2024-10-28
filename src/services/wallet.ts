import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { Wallet } from "../models/wallet";
import WalletRepository from "../repositories/wallet";

@Service()
class WalletService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly walletRepository_: typeof WalletRepository;

  constructor(container) {
    super(container);
    this.logger_ = container.logger;
    this.walletRepository_ = container.walletRepository;
  }

  /**
   * Creates a new wallet for a user.
   * @param userId - ID of the user for whom the wallet is created.
   */
  async createWallet(userId: string): Promise<Wallet> {
    const walletRepo = this.activeManager_.withRepository(
      this.walletRepository_
    );
    const wallet = walletRepo.create({ user_id: userId, total_balance: 0 });
    return await walletRepo.save(wallet);
  }

  /**
   * Retrieves a wallet by user ID.
   * @param userId - ID of the user.
   */
  async getWalletByUserId(userId: string): Promise<Wallet | null> {
    return await this.walletRepository_.findOne({ where: { user_id: userId } });
  }
}

export default WalletService;
