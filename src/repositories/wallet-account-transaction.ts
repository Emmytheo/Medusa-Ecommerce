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
      accountId: string,
      amount: number,
      type: string,
      description?: string
    ): Promise<WalletAccountTransaction> {
      const transaction = this.create({
        account_id: accountId,
        amount,
        type,
        description,
      });
      return this.save(transaction);
    },
  });

export default WalletAccountTransactionRepository;
