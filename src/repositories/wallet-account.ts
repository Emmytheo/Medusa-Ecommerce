import { WalletAccount } from "../models/wallet-account";
import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { Wallet } from "src/models/wallet";
import { In } from "typeorm";
import WalletRepository from "./wallet";
import crypto from "crypto";
import UserRepository from "./user";

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

      const account = await this.findOne({ where: { wallet_id: wallet.id } });
      if (!account) {
        const new_account = this.create({
          wallet_id: wallet.id,
          currency,
          account_numbers: [await generateUniqueAccountNumberWithRetry(this)],
          balance: 0,
        });
        const wlt_ac = await this.save(new_account);
        if (!Object.keys(wallet.total_balance).includes(wlt_ac.currency)) {
          let new_tot_bal = wallet.total_balance;
          new_tot_bal[wlt_ac.currency] = wlt_ac.balance;
          await WalletRepository.save({
            ...wallet,
            total_balance: { ...new_tot_bal },
          });
        }

        if (wlt_ac && wlt_ac.id) return wlt_ac;
        // return this.findOne({ where: { wallet_id: wallet.id, ...wlt_ac } });
      } else {
        if (!Object.keys(wallet.total_balance).includes(account.currency)) {
          let new_tot_bal = wallet.total_balance;
          new_tot_bal[account.currency] = account.balance;
          await WalletRepository.save({
            ...wallet,
            total_balance: { ...new_tot_bal },
          });
        }
        return account;
      }
    },

    async updateAccountBalance(
      accountId: string,
      amount: number
    ): Promise<void> {
      const account = await this.findOne({ where: { id: accountId } });
      if (!account) throw new Error("Account not found");
      account.balance =
        parseFloat(account.balance) + parseFloat(amount.toFixed(2));
      this.save(account);
    },
  });

function generateUniqueAccountNumber(): string {
  // Base account number format: 10-digit numeric value
  const prefix = "AC"; // Optional prefix (e.g., for identifying the account type)
  const uniquePart = Date.now().toString().slice(-6); // Last 6 digits of the timestamp
  const randomPart = crypto.randomInt(1000, 9999).toString(); // 4 random digits

  return `${prefix}${uniquePart}${randomPart}`;
}

async function generateUniqueAccountNumberWithRetry(
  repository
): Promise<string> {
  let isUnique = false;
  let accountNumber = "";

  while (!isUnique) {
    accountNumber = generateUniqueAccountNumber();
    const existing = await repository.findOne({
      where: { account_numbers: [accountNumber] },
    });
    if (!existing) isUnique = true;
  }

  return accountNumber;
}

export default WalletAccountRepository;
