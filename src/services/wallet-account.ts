import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { WalletAccount } from "../models/wallet-account";
import WalletAccountRepository from "../repositories/wallet-account";

@Service()
class WalletAccountService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly walletAccountRepository_: typeof WalletAccountRepository;

  constructor(container) {
    super(container);
    this.logger_ = container.logger;
    this.walletAccountRepository_ = container.walletAccountRepository;
  }

  /**
   * Creates a wallet account in a specified currency.
   * @param walletId - ID of the wallet.
   * @param currency - Currency code for the account.
   */
  async createWalletAccount(
    walletId: string,
    currency: string
  ): Promise<WalletAccount> {
    const walletAccountRepo = this.activeManager_.withRepository(
      this.walletAccountRepository_
    );
    const account = walletAccountRepo.create({
      wallet_id: walletId,
      currency,
      balance: 0,
    });
    return await walletAccountRepo.save(account);
  }

  /**
   * Retrieves a wallet account by wallet ID and currency.
   * @param walletId - ID of the wallet.
   * @param currency - Currency code.
   */
  async getWalletAccount(
    walletId: string,
    currency: string
  ): Promise<WalletAccount | null> {
    return await this.walletAccountRepository_.findOne({
      where: { wallet_id: walletId, currency },
    });
  }
}

export default WalletAccountService;
