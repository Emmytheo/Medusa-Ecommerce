import { Wallet } from "../models/wallet";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";

export const WalletRepository = dataSource.getRepository(Wallet).extend({
  async createWallet(userId: string): Promise<Wallet> {
    const wallet = this.create({ id: userId, balance: 0 });
    return await this.save(wallet);
  },

  async updateBalance(walletId: string, amount: number): Promise<Wallet> {
    const wallet = await this.findOne({ where: { id: walletId } });
    if (!wallet) throw new Error("Wallet not found");

    wallet.balance += amount;
    return await this.save(wallet);
  },

  async getWalletBalance(userId: string): Promise<number> {
    const wallet = await this.findOne({ where: { id: userId } });
    return wallet ? wallet.balance : 0;
  },

  async getWallet(userId: string): Promise<Wallet | null> {
    return this.findOne({ where: { user_id: userId } });
  }
});

export default WalletRepository;
