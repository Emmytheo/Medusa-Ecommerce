import { Service } from "typedi";
import { WalletAccount } from "../models/wallet-account";
import { WalletAccountRepository } from "../repositories/wallet-account";
import WalletService from "../services/wallet"; // Assuming you have a WalletService to interact with wallets

@Service()
class VirtualAccountService {
  constructor(
    private walletAccountRepository: typeof WalletAccountRepository,
    private walletService: WalletService
  ) {}

  async generateVirtualAccount(
    userId: string,
    currency: string
  ): Promise<string> {
    // Logic to generate and return a unique virtual account number
    // This could involve calling an external API or using a local generation strategy
    return `VA-${userId}-${currency}-${Date.now()}`; // Example implementation
  }

  async assignWalletAccount(
    walletId: string,
    userId: string,
    currency: string
  ): Promise<WalletAccount> {
    const accountNumber = await this.generateVirtualAccount(userId, currency);
    const walletAccount = await this.walletAccountRepository.create({
      wallet_id: walletId,
      currency,
      account_numbers: [accountNumber], // Store the virtual account number
      balance: 0,
    });

    // Optionally update the wallet's total balance or other attributes here
    await this.walletService.updateWalletTotalBalance(walletId);

    return walletAccount;
  }
}

export default VirtualAccountService;
