// repositories/wallet

import { Wallet } from "../models/wallet";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import UserRepository from "./user";

export const WalletRepository = dataSource.getRepository(Wallet).extend({
  async createWallet(userId: string): Promise<Wallet> {
    let wallet = await this.findOne({ where: { user_id: userId } });
    const user = await UserRepository.findOne({ where: { id: userId } });
    if (!wallet) {
      const new_wallet = this.create({ user_id: userId, total_balance: { NGN: 0 } });
      await this.save(new_wallet);
      wallet = await this.findOne({ where: { user_id: userId } });
    }
    if (wallet && user && user.wallet_id !== wallet.id) {
      await UserRepository.update(user.id, { wallet_id: wallet.id });
    }
    return wallet!;
  },

  async updateBalance(
    userId: string,
    currency: string,
    amount: number
  ): Promise<Wallet> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    if (!wallet) throw new Error("Wallet not found");

    if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
      wallet.total_balance = {};
    }

    // Initialize currency balance if it doesn't exist
    if (wallet.total_balance[currency] === undefined) {
      wallet.total_balance[currency] = 0;
    }

    // Update balance for the specified currency
    wallet.total_balance[currency] += parseFloat(amount.toFixed(2));
    await this.update(wallet.id, { total_balance: wallet.total_balance });
    return (await this.findOne({ where: { id: wallet.id } }))!;
  },

  async getWalletBalance(userId: string, currency: string): Promise<number> {
    const wallet = await this.findOne({ where: { user_id: userId } });
    return wallet && wallet.total_balance && wallet.total_balance[currency] !== undefined
      ? wallet.total_balance[currency]
      : 0;
  },

  async getWallet(userId: string): Promise<Wallet | null> {
    return this.findOne({ where: { user_id: userId } });
  },
});

export default WalletRepository;
