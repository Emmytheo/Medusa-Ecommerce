// services/wallet-payment-processor

import { Service, Container } from "typedi";
import { WalletRepository } from "../repositories/wallet";
import { WalletAccountTransaction } from "../models/wallet-account-transaction";
import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";

@Service()
class WalletPaymentProcessor extends TransactionBaseService {
  constructor(
    private walletRepository: typeof WalletRepository,
    @InjectManager() manager: EntityManager,
    container: Container
  ) {
    super(container);
  }

  async authorizePayment(
    userId: string,
    amount: number,
    currency: string
  ): Promise<boolean> {
    const balance = await this.walletRepository.getWalletBalance(
      userId,
      currency
    );
    return balance >= amount;
  }

  async recordTransaction(
    userId: string,
    walletAccountId: string,
    amount: number,
    currency: string,
    type: "debit" | "credit"
  ): Promise<WalletAccountTransaction> {
    const currentBalance = await this.walletRepository.getWalletBalance(
      userId,
      currency
    );

    if (type === "debit" && currentBalance < amount) {
      throw new Error("Insufficient funds");
    }

    const adjustment = type === "credit" ? amount : -amount;

    // Update wallet balance for the specified currency
    await this.walletRepository.updateBalance(userId, currency, adjustment);

    // Record the transaction
    const transaction = await this.createTransaction(
      walletAccountId,
      amount,
      currency,
      type,
      this.manager_
    );

    return transaction;
  }

  private async createTransaction(
    walletAccountId: string,
    amount: number,
    currency: string,
    type: "debit" | "credit",
    manager: EntityManager
  ): Promise<WalletAccountTransaction> {
    const transactionRepo = manager.getRepository(WalletAccountTransaction);

    const transaction = transactionRepo.create({
      wallet_account_id: walletAccountId,
      amount,
      type,
      status: "pending",
      metadata: { currency }, // Store currency in metadata for reference
    });

    return await transactionRepo.save(transaction);
  }
}

export default WalletPaymentProcessor;
