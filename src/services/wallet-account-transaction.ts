import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { WalletAccountTransaction } from "../models/wallet-account-transaction";
import WalletAccountTransactionRepository from "../repositories/wallet-account-transaction";

@Service()
class WalletAccountTransactionService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly transactionRepository_: typeof WalletAccountTransactionRepository;

  constructor(container) {
    super(container);
    this.logger_ = container.logger;
    this.transactionRepository_ = container.walletAccountTransactionRepository;
  }

  /**
   * Logs a new transaction.
   * @param accountId - ID of the wallet account.
   * @param amount - Transaction amount.
   * @param type - Type of transaction ("credit" or "debit").
   * @param status - Status of the transaction.
   * @param metadata - Optional metadata for the transaction.
   */
  async createTransaction(
    accountId: string,
    amount: number,
    type: "credit" | "debit",
    status: "pending" | "completed" | "failed",
    metadata: Record<string, any> = {}
  ): Promise<WalletAccountTransaction> {
    const transactionRepo = this.activeManager_.withRepository(
      this.transactionRepository_
    );
    const transaction = transactionRepo.create({
      wallet_account_id: accountId,
      amount,
      type,
      status,
      metadata,
    });
    return await transactionRepo.save(transaction);
  }

  /**
   * Retrieves transactions by wallet account ID.
   * @param accountId - ID of the wallet account.
   */
  async getTransactionsByAccountId(
    accountId: string
  ): Promise<WalletAccountTransaction[]> {
    return await this.transactionRepository_.find({
      where: { wallet_account_id: accountId },
    });
  }
}

export default WalletAccountTransactionService;
