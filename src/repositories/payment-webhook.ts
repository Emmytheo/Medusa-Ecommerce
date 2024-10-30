import { dataSource } from "@medusajs/medusa/dist/loaders/database";
import { User } from "../models/user";
import { Wallet } from "../models/wallet";
import WalletRepository from "../repositories/wallet";
import { In } from "typeorm";
import { PaymentWebhook } from "../models/payment-webhook";


type PaymentEvent = {
  userId: string;
  amount: number;
  eventType: "FUND_WALLET" | "SPEND_WALLET";
};

const PaymentWebhookRepository = dataSource
  .getRepository(PaymentWebhook)
  .extend({
    async handlePaymentEvent(event: PaymentEvent) {
      const { userId, amount, eventType } = event;

      // Fetch the user and check if they already have a wallet
      const user = await this.findOne({
        where: { id: userId },
        relations: ["wallet"],
      });

      if (!user) {
        throw new Error("User not found.");
      }

      // If the user does not have a wallet, create one
      if (!user.wallet) {
        const walletRepo = this.manager.withRepository(WalletRepository);
        const newWallet = await walletRepo.save(walletRepo.create({ user }));
        user.wallet = newWallet;
        await this.save(user);
      }

      // Update wallet balance based on the event type
      if (user.wallet) {
        const walletRepo = this.manager.withRepository(WalletRepository);
        if (eventType === "FUND_WALLET") {
          user.wallet.balance += amount;
        } else if (eventType === "SPEND_WALLET") {
          user.wallet.balance -= amount;
        }

        await walletRepo.save(user.wallet);
      }
    },
  });

export default PaymentWebhookRepository;
