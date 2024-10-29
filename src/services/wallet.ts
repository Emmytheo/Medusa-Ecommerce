import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { Wallet } from "../models/wallet";
import WalletRepository from "../repositories/wallet";
import WalletAccountRepository from "../repositories/wallet-account";

@Service()
class WalletService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly walletRepository_: typeof WalletRepository;
  protected readonly walletAccountRepository_: typeof WalletAccountRepository;

  constructor(container) {
    super(container);
    this.logger_ = container.logger;
    this.walletRepository_ = container.walletRepository;
    this.walletAccountRepository_ = container.walletAccountRepository;
  }

  /**
   * Creates a new wallet for a user.
   * @param userId - ID of the user for whom the wallet is created.
   */
  async createWallet(userId: string): Promise<Wallet> {
    const walletRepo = this.activeManager_.withRepository(
      this.walletRepository_
    );

    return await walletRepo.createWallet(userId);
  }

  /**
   * Retrieves a wallet by user ID.
   * @param userId - ID of the user.
   */
  async getWalletByUserId(userId: string): Promise<Wallet | null> {
    return await this.walletRepository_.findOne({ where: { user_id: userId } });
  }

  async updateWalletTotalBalance(walletId: string): Promise<void> {
    const wallet = await this.walletRepository_.findOne({
      where: { id: walletId },
    });
    if (wallet) {
      // Calculate total balance per currency
      const balancePerCurrency = await this.calculateTotalBalance(walletId);
      wallet.total_balance = balancePerCurrency;
      await this.walletRepository_.save(wallet);
    }
  }

  private async calculateTotalBalance(
    walletId: string
  ): Promise<Record<string, number>> {
    const accounts = await this.walletAccountRepository_.find({
      where: { wallet_id: walletId },
    });

    return accounts.reduce((acc, account) => {
      // Initialize balance for each currency
      if (!acc[account.currency]) {
        acc[account.currency] = 0;
      }
      // Sum up balances for each currency separately
      acc[account.currency] += account.balance;
      return acc;
    }, {} as Record<string, number>);
  }
}

export default WalletService;
