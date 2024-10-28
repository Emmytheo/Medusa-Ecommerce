import { WalletAccount } from "../models/wallet-account";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { In } from "typeorm";

export const WalletAccountRepository = dataSource
  .getRepository(WalletAccount)
  .extend({
    async findByCurrencyAndUserId(
      currency: string,
      userId: string
    ): Promise<WalletAccount | undefined> {
      return this.findOne({ where: { currency, user_id: userId } });
    },

    async createAccount(
      userId: string,
      currency: string
    ): Promise<WalletAccount> {
      const account = this.create({ user_id: userId, currency, balance: 0 });
      return this.save(account);
    },

    async updateAccountBalance(
      accountId: string,
      amount: number
    ): Promise<void> {
      const account = await this.findOne({ where: { id: accountId } });
      if (!account) throw new Error("Account not found");

      account.balance += amount;
      await this.save(account);
    },
  });

export default WalletAccountRepository;
