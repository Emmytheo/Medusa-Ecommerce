import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import { v4 as uuidv4 } from "uuid";
import PaystackService from "./paystack-service";
import OtpService from "./otp-service";
import WalletPaymentProcessorService from "./wallet-payment-processor";
import VendorBankAccountRepository from "../repositories/vendor-bank-account";
import VendorPayoutRepository from "../repositories/vendor-payout";
import WalletRepository from "../repositories/wallet";
import WalletAccountRepository from "../repositories/wallet-account";
import WalletAccountTransactionRepository from "../repositories/wallet-account-transaction";
import UserRepository from "../repositories/user";
import { VendorBankAccount } from "../models/vendor-bank-account";
import { VendorPayout } from "../models/vendor-payout";

@Service()
export class VendorWalletService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly paystackService_: PaystackService;
  protected readonly otpService_: OtpService;
  protected readonly walletPaymentProcessorService_: WalletPaymentProcessorService;
  protected readonly vendorBankAccountRepository_: typeof VendorBankAccountRepository;
  protected readonly vendorPayoutRepository_: typeof VendorPayoutRepository;
  protected readonly walletRepository_: typeof WalletRepository;
  protected readonly walletAccountRepository_: typeof WalletAccountRepository;
  protected readonly walletAccountTransactionRepository_: typeof WalletAccountTransactionRepository;
  protected readonly userRepository_: typeof UserRepository;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
    try {
      this.paystackService_ = container.paystackServiceService || container.paystackService;
    } catch (e) {
      this.paystackService_ = new PaystackService(container);
    }
    try {
      this.otpService_ = container.otpServiceService || container.otpService;
    } catch (e) {
      this.otpService_ = new OtpService(container);
    }
    try {
      this.walletPaymentProcessorService_ = container.walletPaymentProcessorService;
    } catch (e) {}
    try {
      this.vendorBankAccountRepository_ = container.vendorBankAccountRepository;
    } catch (e) {
      this.vendorBankAccountRepository_ = VendorBankAccountRepository;
    }
    try {
      this.vendorPayoutRepository_ = container.vendorPayoutRepository;
    } catch (e) {
      this.vendorPayoutRepository_ = VendorPayoutRepository;
    }
    try {
      this.walletRepository_ = container.walletRepository;
    } catch (e) {
      this.walletRepository_ = WalletRepository;
    }
    try {
      this.walletAccountRepository_ = container.walletAccountRepository;
    } catch (e) {
      this.walletAccountRepository_ = WalletAccountRepository;
    }
    try {
      this.walletAccountTransactionRepository_ = container.walletAccountTransactionRepository;
    } catch (e) {
      this.walletAccountTransactionRepository_ = WalletAccountTransactionRepository;
    }
    try {
      this.userRepository_ = container.userRepository;
    } catch (e) {
      this.userRepository_ = UserRepository;
    }
    if (!this.paystackService_) this.paystackService_ = new PaystackService(container);
    if (!this.otpService_) this.otpService_ = new OtpService(container);
    if (!this.vendorBankAccountRepository_) this.vendorBankAccountRepository_ = VendorBankAccountRepository;
    if (!this.vendorPayoutRepository_) this.vendorPayoutRepository_ = VendorPayoutRepository;
    if (!this.walletRepository_) this.walletRepository_ = WalletRepository;
    if (!this.walletAccountRepository_) this.walletAccountRepository_ = WalletAccountRepository;
    if (!this.walletAccountTransactionRepository_) this.walletAccountTransactionRepository_ = WalletAccountTransactionRepository;
    if (!this.userRepository_) this.userRepository_ = UserRepository;
  }

  /**
   * Retrieves complete wallet overview for vendor including balances, accounts, bank details, and recent transactions.
   */
  async getVendorWalletOverview(userId: string, storeId: string) {
    const walletRepo = this.activeManager_.withRepository(this.walletRepository_);
    const walletAccountRepo = this.activeManager_.withRepository(this.walletAccountRepository_);
    const bankAccountRepo = this.activeManager_.withRepository(this.vendorBankAccountRepository_);
    const transactionRepo = this.activeManager_.withRepository(this.walletAccountTransactionRepository_);

    let wallet = await walletRepo.getWallet(userId);
    if (!wallet) {
      wallet = await walletRepo.createWallet(userId);
    }

    const accounts = await walletAccountRepo.find({
      where: { wallet_id: wallet.id },
    });

    const bankAccount = await bankAccountRepo.findByStoreId(storeId);

    // Fetch transactions across all vendor accounts
    const accountIds = accounts.map((a) => a.id);
    let transactions: any[] = [];
    if (accountIds.length > 0) {
      transactions = await transactionRepo
        .createQueryBuilder("wat")
        .where("wat.wallet_account_id IN (:...accountIds)", { accountIds })
        .orderBy("wat.created_at", "DESC")
        .take(50)
        .getMany();
    }

    return {
      wallet,
      accounts,
      bankAccount,
      transactions,
    };
  }

  /**
   * Saves/Updates vendor business bank account with mandatory Paystack verification and OTP confirmation.
   */
  async saveVendorBankAccount(
    userId: string,
    storeId: string,
    bankCode: string,
    bankName: string,
    accountNumber: string,
    otpCode: string
  ): Promise<VendorBankAccount> {
    // 1. Verify OTP
    const isOtpValid = await this.otpService_.verifyOtp(userId, "bank_account_update", otpCode);
    if (!isOtpValid) {
      throw new Error("Invalid or expired OTP code. Please request a new verification code.");
    }

    // 2. Resolve account details with Paystack Lookup API
    const resolved = await this.paystackService_.resolveAccountNumber(accountNumber, bankCode);
    if (!resolved || !resolved.account_name) {
      throw new Error("Could not verify account name from Paystack. Please check the account number.");
    }

    // 3. Create Paystack Transfer Recipient
    let recipientCode: string | undefined;
    try {
      const recipient = await this.paystackService_.createTransferRecipient(
        resolved.account_name,
        accountNumber,
        bankCode,
        "NGN"
      );
      recipientCode = recipient?.recipient_code;
    } catch (e: any) {
      this.logger_.warn(`[VendorWalletService] Could not generate Paystack recipient: ${e.message}`);
    }

    // 4. Save/Update VendorBankAccount record
    const bankAccountRepo = this.activeManager_.withRepository(this.vendorBankAccountRepository_);
    let bankAccount = await bankAccountRepo.findByStoreId(storeId);

    if (!bankAccount) {
      bankAccount = bankAccountRepo.create({
        user_id: userId,
        store_id: storeId,
        bank_name: bankName,
        bank_code: bankCode,
        account_number: accountNumber.trim().replace(/\D/g, ""),
        account_name: resolved.account_name,
        recipient_code: recipientCode,
        currency: "NGN",
        is_verified: true,
      });
    } else {
      bankAccount.bank_name = bankName;
      bankAccount.bank_code = bankCode;
      bankAccount.account_number = accountNumber.trim().replace(/\D/g, "");
      bankAccount.account_name = resolved.account_name;
      if (recipientCode) {
        bankAccount.recipient_code = recipientCode;
      }
      bankAccount.is_verified = true;
    }

    const saved = await bankAccountRepo.save(bankAccount);
    this.logger_.info(`[VendorWalletService] Bank account saved for store ${storeId} (${resolved.account_name})`);
    return saved;
  }

  /**
   * Processes a vendor withdrawal / payout request secured by OTP.
   */
  async requestPayout(
    userId: string,
    storeId: string,
    amount: number,
    currency: string = "ngn",
    otpCode: string
  ): Promise<VendorPayout> {
    if (amount <= 0) {
      throw new Error("Payout amount must be greater than zero.");
    }

    // 1. Verify OTP
    const isOtpValid = await this.otpService_.verifyOtp(userId, "payout_request", otpCode);
    if (!isOtpValid) {
      throw new Error("Invalid or expired OTP code. Payout request aborted.");
    }

    // 2. Fetch verified bank account
    const bankAccountRepo = this.activeManager_.withRepository(this.vendorBankAccountRepository_);
    const bankAccount = await bankAccountRepo.findByStoreId(storeId);
    if (!bankAccount || !bankAccount.is_verified) {
      throw new Error("No verified bank account found. Please configure your business bank account before requesting payouts.");
    }

    // 3. Check wallet balance
    const walletAccountRepo = this.activeManager_.withRepository(this.walletAccountRepository_);
    const walletRepo = this.activeManager_.withRepository(this.walletRepository_);
    const payoutRepo = this.activeManager_.withRepository(this.vendorPayoutRepository_);
    const transactionRepo = this.activeManager_.withRepository(this.walletAccountTransactionRepository_);

    const normalizedCurrency = currency.toLowerCase();
    const account = await walletAccountRepo
      .createQueryBuilder("wa")
      .leftJoinAndSelect("wa.wallet", "w")
      .where("w.user_id = :userId", { userId })
      .andWhere("LOWER(wa.currency) = :currency", { currency: normalizedCurrency })
      .getOne();

    if (!account) {
      throw new Error(`No wallet account found for currency ${currency.toUpperCase()}`);
    }

    if (Number(account.balance) < amount) {
      throw new Error(`Insufficient funds. Available balance: ${account.balance} ${currency.toUpperCase()}`);
    }

    // 4. Generate reference & record debit
    const reference = `payout_${Date.now()}_${uuidv4().substring(0, 8)}`;

    // Atomic balance update
    await this.walletPaymentProcessorService_.recordTransaction(
      userId,
      account.id,
      amount,
      currency.toUpperCase(),
      "debit",
      {
        type: "payout",
        reference,
        bank_name: bankAccount.bank_name,
        account_number: bankAccount.account_number,
        account_name: bankAccount.account_name,
      }
    );

    // 5. Create Payout record
    const payout = payoutRepo.create({
      user_id: userId,
      store_id: storeId,
      wallet_account_id: account.id,
      amount,
      currency: currency.toUpperCase(),
      status: "pending",
      reference,
      bank_account_snapshot: {
        bank_name: bankAccount.bank_name,
        bank_code: bankAccount.bank_code,
        account_number: bankAccount.account_number,
        account_name: bankAccount.account_name,
        recipient_code: bankAccount.recipient_code,
      },
    });

    const savedPayout = await payoutRepo.save(payout);

    // 6. Attempt automated Paystack transfer if recipient_code exists
    if (bankAccount.recipient_code) {
      try {
        const transferRes = await this.paystackService_.initiateTransfer(
          amount,
          bankAccount.recipient_code,
          reference,
          `Vendor payout to ${bankAccount.account_name}`
        );

        if (transferRes && transferRes.transfer_code) {
          savedPayout.transfer_code = transferRes.transfer_code;
          savedPayout.status = "processing";
          await payoutRepo.save(savedPayout);
        }
      } catch (transferErr: any) {
        this.logger_.warn(`[VendorWalletService] Automated Paystack transfer queued: ${transferErr.message}`);
      }
    }

    this.logger_.info(`[VendorWalletService] Payout request ${savedPayout.id} (${amount} ${currency.toUpperCase()}) created for store ${storeId}`);
    return savedPayout;
  }

  /**
   * Lists payout requests for a store.
   */
  async listPayouts(storeId: string, limit: number = 50, offset: number = 0) {
    const payoutRepo = this.activeManager_.withRepository(this.vendorPayoutRepository_);
    return await payoutRepo.listByStoreId(storeId, limit, offset);
  }
}

export default VendorWalletService;
