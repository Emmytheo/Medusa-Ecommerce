// repositories/wallet

import { Wallet } from "../models/wallet";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import UserRepository from "./user";

export const WalletRepository = dataSource.getRepository(Wallet).extend({
  async createWallet(userId: string): Promise<Wallet> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    const user = await UserRepository.findOne({ where: { id: userId } });
    if (!wallet) {
      const new_wallet = this.create({ user_id: userId, total_balance: {} });
      const wlt = await this.save(new_wallet);
      await UserRepository.save({ ...user, wallet_id: wlt.id });
      if (wlt && wlt.id) return wlt;
      // return this.findOne({ where: { user_id: userId, ...wlt }, select: ['id'] })
    } else {
      if (!user.wallet_id) {
        await UserRepository.save({ ...user, wallet_id: wallet.id });
      }
      return wallet;
    }
  },

  async updateBalance(
    userId: string,
    currency: string,
    amount: number
  ): Promise<Wallet> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    if (!wallet) throw new Error("Wallet not found");

    // Initialize currency balance if it doesn't exist
    if (!wallet.total_balance[currency]) {
      wallet.total_balance[currency] = 0;
    }

    // Update balance for the specified currency
    wallet.total_balance[currency] += parseFloat(amount.toFixed(2));
    return await this.save(wallet);
  },

  async getWalletBalance(userId: string, currency: string): Promise<number> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    return wallet && wallet.total_balance[currency]
      ? wallet.total_balance[currency]
      : 0;
  },

  async getWallet(userId: string): Promise<Wallet | null> {
    return this.findOne({ where: { user_id: userId } });
  },
});

export default WalletRepository;
