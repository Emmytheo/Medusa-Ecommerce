import { WalletAccount } from "../models/wallet-account";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { Wallet } from "src/models/wallet";
import { In } from "typeorm";
import WalletRepository from "./wallet";

export const WalletAccountRepository = dataSource
  .getRepository(WalletAccount)
  .extend({
    async findByCurrencyAndUserId(
      currency: string,
      userId: string
    ): Promise<WalletAccount | undefined> {
      const wallet = await WalletRepository.getWallet(userId);
      if (!wallet) throw new Error("Wallet not found");

      return this.findOne({
        where: { currency, wallet_id: wallet.id },
      });
    },

    async createAccount(
      userId: string,
      currency: string
    ): Promise<WalletAccount> {
      const wallet = await WalletRepository.createWallet(userId);
      const account = this.create({
        wallet_id: wallet.id,
        currency,
        balance: 0,
      });
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
