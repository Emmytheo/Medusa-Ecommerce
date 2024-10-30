// repositories/wallet

import { Wallet } from "../models/wallet";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const WalletRepository = dataSource.getRepository(Wallet).extend({
  async createWallet(userId: string): Promise<Wallet> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    if (!wallet) {
      const new_wallet = this.create({ id: userId, total_balance: {} });
      return await this.save(new_wallet);
    } else {
      return wallet;
    }
  },

  async updateBalance(
    walletId: string,
    currency: string,
    amount: number
  ): Promise<Wallet> {
    const wallet = await this.findOne({ where: { id: walletId } });
    if (!wallet) throw new Error("Wallet not found");

    // Initialize currency balance if it doesn't exist
    if (!wallet.total_balance[currency]) {
      wallet.total_balance[currency] = 0;
    }

    // Update balance for the specified currency
    wallet.total_balance[currency] += amount;
    return await this.save(wallet);
  },

  async getWalletBalance(userId: string, currency: string): Promise<number> {
    const wallet = await this.findOne({ where: { id: userId } });
    return wallet && wallet.total_balance[currency]
      ? wallet.total_balance[currency]
      : 0;
  },

  async getWallet(userId: string): Promise<Wallet | null> {
    return this.findOne({ where: { user_id: userId } });
  },
});

export default WalletRepository;
