import { WalletAccountTransaction } from "../models/wallet-account-transaction";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { In } from "typeorm";

export const WalletAccountTransactionRepository = dataSource
  .getRepository(WalletAccountTransaction)
  .extend({
    async findTransactionsByAccountId(
      accountId: string
    ): Promise<WalletAccountTransaction[]> {
      return this.find({
        where: { account_id: accountId },
        order: { created_at: "DESC" },
      });
    },

    async createTransaction(
      walletAccountId: string,
      amount: number,
      currency: string,
      type: "debit" | "credit"
      // manager: EntityManager
    ): Promise<WalletAccountTransaction> {
      
      const transaction = this.create({
        wallet_account_id: walletAccountId,
        amount,
        type,
        status: "pending",
        metadata: { currency }, // Store currency in metadata for reference
      });

      return this.save(transaction);
    },
  });

export default WalletAccountTransactionRepository;
