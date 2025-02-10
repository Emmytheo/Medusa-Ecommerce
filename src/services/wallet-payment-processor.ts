// services/wallet-payment-processor

import { Service, Container } from "typedi";
import { WalletRepository } from "../repositories/wallet";
import { WalletAccountTransaction } from "../models/wallet-account-transaction";
import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import WalletAccountTransactionRepository from "src/repositories/wallet-account-transaction";
import WalletAccountRepository from "src/repositories/wallet-account";

@Service()
class WalletPaymentProcessorService extends TransactionBaseService {
  protected readonly walletRepository: typeof WalletRepository;
  protected readonly walletAccountRepository: typeof WalletAccountRepository;
  protected readonly walletAccountTransactionRepository: typeof WalletAccountTransactionRepository;

  constructor(container, options) {
    // @ts-expect-error prefer-rest-params
    super(...arguments);
    this.walletRepository = container.walletRepository;
    this.walletAccountRepository =
      container.walletAccountRepository;
      this.walletAccountTransactionRepository =
      container.walletAccountTransactionRepository;
  }

  async authorizePayment(
    userId: string,
    amount: number,
    currency: string
  ): Promise<boolean> {
    const walletRepo = this.activeManager_.withRepository(
      this.walletRepository
    );
    const balance = await walletRepo.getWalletBalance(userId, currency);
    return balance >= amount;
  }

  async recordTransaction(
    userId: string,
    walletAccountId: string,
    amount: number,
    currency: string,
    type: "debit" | "credit"
  ): Promise<WalletAccountTransaction> {
    const walletRepo = this.activeManager_.withRepository(
      this.walletRepository
    );
    const walletAccountRepo = this.activeManager_.withRepository(
      this.walletAccountRepository
    );
    const walletAccountTransactionRepo = this.activeManager_.withRepository(
      this.walletAccountTransactionRepository
    );
    const currentBalance = await walletRepo.getWalletBalance(userId, currency);

    if (type === "debit" && currentBalance < amount) {
      throw new Error("Insufficient funds");
    }

    const adjustment = type === "credit" ? amount : -amount;

    // Update wallet balance for the specified currency
    await this.walletRepository.updateBalance(userId, currency, adjustment);

    const wa = await this.walletAccountRepository.updateAccountBalance(walletAccountId, adjustment);

    // console.log(wa);
    // Record the transaction
    const transaction = await walletAccountTransactionRepo.createTransaction(
      walletAccountId,
      parseFloat(amount.toFixed(2)),
      currency,
      type
      // this.manager_
    );

    return transaction;
  }
}

export default WalletPaymentProcessorService;
