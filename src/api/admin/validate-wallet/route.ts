import { Logger, MedusaContainer, MedusaRequest, MedusaResponse } from "@medusajs/medusa";
import { Request, Response } from "express";
import { Store } from "../../../models/store";
import { User } from "../../../models/user";
import { WalletAccount } from "../../../models/wallet-account";
import { StoreRepository } from "../../../repositories/store";
import { UserRepository } from "../../../repositories/user";
import { WalletAccountRepository } from "../../../repositories/wallet-account";
import UserService from "../../../services/user";
import activateWalletWorkflow from "../../../workflows/activate-wallet-workflow";
import auditWalletWorkflow from "../../../workflows/audit-wallet-workflow";

export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  let loggedInUser: any = null;
  const container: MedusaContainer = req.scope;
  const logger: Logger = container.resolve("logger");
  const walletAccountRepository: typeof WalletAccountRepository =
    container.resolve("walletAccountRepository");
  const userRepository: typeof UserRepository =
    container.resolve("userRepository");
  const storeRepository: typeof StoreRepository =
    container.resolve("storeRepository");

  async function findUserByStoreId(store_id: string): Promise<User | null> {
    const result = await userRepository.findOne({ where: { store_id } });
    return result;
  }

  async function getStore(store_id: string): Promise<Store | null> {
    const result = await storeRepository.findOne({ where: { id: store_id } });
    return result;
  }

  async function createWalletAccount(
    user_id: string,
    currencyCode: string
  ): Promise<WalletAccount> {
    const walletAccount = await walletAccountRepository.createAccount(
      user_id,
      currencyCode
    );

    console.log(walletAccount, walletAccount.id);
    return walletAccount;
  }

  if (req.user && req.user.id) {
    loggedInUser = req.user;
    if (loggedInUser) {
      logger.info("User Logged in");
      console.log(`Checking User Wallet: ${loggedInUser.email}`);
      try {
        const store = await getStore(loggedInUser.store_id);

        const walletAccount = await createWalletAccount(
          loggedInUser.id,
          store.default_currency_code
        );
        logger.info(`Wallet Validated for ${loggedInUser.email}`);

        // Trigger Wallet Audit
        const { result: auditResult } = await auditWalletWorkflow(container).run({
          input: {
            store_id: loggedInUser.store_id,
            admin_user_id: loggedInUser.id,
          },
        });

        res.status(200).json({ loggedInUser, walletAccount, auditResult });
      } catch (error) {
        logger.error(`Error Validating Wallet:`, error);
        throw error;
      }
    } else {
      res.sendStatus(401).send("User not logged in");
    }
  } else {
    res.sendStatus(401);
  }
};
