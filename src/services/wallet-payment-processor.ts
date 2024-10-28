import { Service } from "typedi";
import { WalletRepository } from "../repositories/wallet";
import { WalletAccountTransaction } from "../models/wallet-account-transaction"; // Import transaction model
import { TransactionBaseService } from "@medusajs/medusa";

@Service()
class WalletPaymentProcessor extends TransactionBaseService {
  constructor(private walletRepository: typeof WalletRepository) {
    super();
  }

  async authorizePayment(userId: string, amount: number): Promise<boolean> {
    const balance = await this.walletRepository.getWalletBalance(userId);
    return balance >= amount;
  }

  async recordTransaction(
    userId: string,
    walletAccountId: string,
    amount: number,
    type: "debit" | "credit"
  ): Promise<WalletAccountTransaction> {
    const wallet = await this.walletRepository.getWallet(userId);
    const currentBalance = await this.walletRepository.getWalletBalance(userId);

    if (type === "debit" && currentBalance < amount) {
      throw new Error("Insufficient funds");
    }

    const adjustment = type === "credit" ? amount : -amount;

    // Update wallet balance
    await this.walletRepository.updateBalance(userId, adjustment);

    // Record the transaction
    const transaction = await this.createTransaction(
      walletAccountId,
      amount,
      type
    );

    return transaction;
  }

  private async createTransaction(
    walletAccountId: string,
    amount: number,
    type: "debit" | "credit"
  ): Promise<WalletAccountTransaction> {
    const transaction = WalletAccountTransaction.create({
      wallet_account_id: walletAccountId,
      amount,
      type,
      status: "pending", // Default status; can be updated later
      metadata: {}, // Additional data can be added here
    });

    return await transaction.save();
  }
}

export default WalletPaymentProcessor;
