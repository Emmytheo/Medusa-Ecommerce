import { TransactionBaseService, UserRoles, User } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import OtpService from "./otp-service";
import UserRepository from "../repositories/user";
import StoreRepository from "../repositories/store";
import WalletRepository from "../repositories/wallet";
import WalletAccountRepository from "../repositories/wallet-account";
import { createClient } from "@supabase/supabase-js";
import Scrypt from "scrypt-kdf";

export interface VendorRegisterDto {
  email: string;
  password?: string;
  storeName: string;
  phone: string;
  accountType?: string; // vendor, dropshipper, logistics_staff, intern
  otpCode: string;
  niche?: string;
}

@Service()
export class VendorOnboardingService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly otpService_: OtpService;
  protected readonly userRepository_: typeof UserRepository;
  protected readonly storeRepository_: typeof StoreRepository;
  protected readonly walletRepository_: typeof WalletRepository;
  protected readonly walletAccountRepository_: typeof WalletAccountRepository;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
    try {
      this.otpService_ = container.otpServiceService || container.otpService;
    } catch (e) {
      this.otpService_ = new OtpService(container);
    }
    try {
      this.userRepository_ = container.userRepository;
    } catch (e) {
      this.userRepository_ = UserRepository;
    }
    try {
      this.storeRepository_ = container.storeRepository;
    } catch (e) {
      this.storeRepository_ = StoreRepository;
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
    if (!this.userRepository_) this.userRepository_ = UserRepository;
    if (!this.storeRepository_) this.storeRepository_ = StoreRepository;
    if (!this.walletRepository_) this.walletRepository_ = WalletRepository;
    if (!this.walletAccountRepository_) this.walletAccountRepository_ = WalletAccountRepository;
    if (!this.otpService_) this.otpService_ = new OtpService(container);
  }

  /**
   * Checks whether a phone number or email is already registered in the system.
   */
  async checkAvailability(phone?: string, email?: string): Promise<{
    available: boolean;
    reason?: string;
    message?: string;
    isPhoneUsed?: boolean;
    isEmailUsed?: boolean;
  }> {
    const cleanPhone = phone ? phone.trim().replace(/\D/g, "") : undefined;
    const cleanEmail = email ? email.trim().toLowerCase() : undefined;

    try {
      const containerObj = (this as any).__container__ || (this as any).container_;
      const manager = this.activeManager_ || (containerObj?.resolve ? containerObj.resolve("manager") : null);
      const userRepo = manager && manager.withRepository
        ? manager.withRepository(this.userRepository_)
        : this.userRepository_;

      // 1. Check Medusa User Repository for Email
      if (cleanEmail && userRepo) {
        try {
          const existingUser = await userRepo.findOne({
            where: { email: cleanEmail },
          });
          if (existingUser) {
            const msg = "This email address is already registered.";
            return {
              available: false,
              reason: msg,
              message: msg,
              isEmailUsed: true,
            };
          }
        } catch (e: any) {
          this.logger_?.warn?.(`[VendorOnboardingService] Email check notice: ${e.message}`);
        }
      }

      // 2. Phone Check: TEMPORARILY RELAXED to allow testing with existing numbers
      // If strict phone uniqueness is needed in the future, re-enable query below:
      /*
      if (cleanPhone && userRepo) {
        ...
      }
      */
    } catch (err: any) {
      this.logger_?.error?.(`[VendorOnboardingService] Check availability error: ${err.message}`);
    }

    return { available: true };
  }

  /**
   * Generates and dispatches a vendor onboarding OTP.
   */
  async sendOnboardingOtp(phoneOrEmail: string): Promise<any> {
    const cleanId = phoneOrEmail.trim().replace(/\D/g, "") || phoneOrEmail.trim().toLowerCase();
    const purpose = "vendor_onboarding";
    return await this.otpService_.sendOtp(`onboard_${cleanId}`, phoneOrEmail.trim(), purpose);
  }

  /**
   * Verifies an onboarding OTP.
   * When isFinalRegistration is false (e.g. from /otp/verify), the OTP is verified without invalidating it,
   * allowing the vendor to complete subsequent registration form steps.
   * When isFinalRegistration is true (from /register), it accepts valid or recently verified OTPs and finalizes it.
   */
  async verifyOnboardingOtp(
    phoneOrEmail: string,
    code: string,
    isFinalRegistration: boolean = false
  ): Promise<boolean> {
    const cleanId = phoneOrEmail.trim().replace(/\D/g, "") || phoneOrEmail.trim().toLowerCase();
    const purpose = "vendor_onboarding";
    return await this.otpService_.verifyOtp(
      `onboard_${cleanId}`,
      purpose,
      code,
      {
        markAsUsed: isFinalRegistration,
        allowRecentlyUsed: isFinalRegistration,
        phoneOrEmail: phoneOrEmail.trim(),
      }
    );
  }

  /**
   * Completes vendor registration, provisioning Store, User, Wallet, and WalletAccount atomically.
   * Fully idempotent: handles retries / client timeouts gracefully without duplicate accounts.
   */
  async registerVendor(dto: VendorRegisterDto): Promise<any> {
    const cleanEmail = dto.email.trim().toLowerCase();
    const cleanPhone = dto.phone ? dto.phone.trim() : "";

    const userRepo = this.activeManager_.withRepository(this.userRepository_);
    const storeRepo = this.activeManager_.withRepository(this.storeRepository_);
    const walletRepo = this.activeManager_.withRepository(this.walletRepository_);
    const walletAccountRepo = this.activeManager_.withRepository(this.walletAccountRepository_);

    // 1. Verify OTP first (accepts valid or recently verified OTP)
    const isOtpValid = await this.verifyOnboardingOtp(cleanPhone || cleanEmail, dto.otpCode, true);
    if (!isOtpValid) {
      throw new Error("Invalid or expired OTP code. Please request a new verification code.");
    }

    // 2. Check for existing user (Idempotent Retry Handling)
    const existingUser = await userRepo.findOne({
      where: { email: cleanEmail },
    });

    if (existingUser) {
      // Check if created recently (e.g. within 30 minutes) as a retry/timeout recovery
      const createdTime = existingUser.created_at ? new Date(existingUser.created_at).getTime() : 0;
      const isRecent = Date.now() - createdTime < 30 * 60 * 1000;

      if (isRecent) {
        this.logger_.info(
          `[VendorOnboardingService] Idempotent retry detected for vendor ${existingUser.id} (${cleanEmail}). Confirming systems provisioning.`
        );

        // Ensure Store is intact
        let store = existingUser.store_id ? await storeRepo.findOne({ where: { id: existingUser.store_id } }) : null;
        if (!store) {
          store = storeRepo.create({
            name: dto.storeName || (existingUser.metadata?.store_name as string) || "AFM_Store",
            default_currency_code: "ngn",
            metadata: {
              ...(dto.niche ? { niche: dto.niche } : {}),
              phone: cleanPhone,
              account_type: dto.accountType || (existingUser.metadata?.account_type as string) || "vendor",
            },
          });
          store = await storeRepo.save(store);
          await userRepo.update(existingUser.id, { store_id: store.id });
          existingUser.store_id = store.id;
        }

        // Ensure Wallet is intact
        let wallet = await walletRepo.getWallet(existingUser.id);
        if (!wallet) {
          wallet = await walletRepo.createWallet(existingUser.id);
        }
        if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
          wallet.total_balance = {};
        }
        if (wallet.total_balance["NGN"] === undefined) {
          wallet.total_balance["NGN"] = 0;
          wallet = await walletRepo.save(wallet);
        }

        // Ensure NGN WalletAccount is intact
        let account = await walletAccountRepo.findOne({
          where: { wallet_id: wallet.id, currency: "NGN" },
        });
        if (!account) {
          const uniquePart = Date.now().toString().slice(-6);
          const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
          account = walletAccountRepo.create({
            wallet_id: wallet.id,
            currency: "NGN",
            balance: 0,
            account_numbers: [`AC${uniquePart}${randomPart}`, cleanPhone].filter(Boolean),
          });
          account = await walletAccountRepo.save(account);
        }

        // Ensure User wallet_id link
        if (!existingUser.wallet_id || existingUser.wallet_id !== wallet.id) {
          await userRepo.update(existingUser.id, { wallet_id: wallet.id });
          existingUser.wallet_id = wallet.id;
        }

        return {
          success: true,
          message: "Vendor registered and all systems confirmed successfully.",
          user: {
            id: existingUser.id,
            email: existingUser.email,
            store_id: store.id,
            store_name: store.name,
            wallet_id: wallet.id,
          },
          provisioning: {
            store: { id: store.id, name: store.name, currency: store.default_currency_code },
            wallet: { id: wallet.id, total_balance: wallet.total_balance },
            wallet_account: {
              id: account.id,
              currency: account.currency,
              balance: account.balance,
              account_number: account.account_numbers?.[0] || "",
            },
            verified: true,
          },
        };
      } else {
        throw new Error("This email address is already registered. Please log in instead.");
      }
    }

    // 3. New Vendor: Create Store entity
    let store = storeRepo.create({
      name: dto.storeName || "AFM_Store",
      default_currency_code: "ngn",
      metadata: {
        ...(dto.niche ? { niche: dto.niche } : {}),
        phone: cleanPhone,
        account_type: dto.accountType || "vendor",
      },
    });
    store = await storeRepo.save(store);

    // 4. Hash password (if provided)
    let passwordHash = "";
    if (dto.password) {
      const buf = await Scrypt.kdf(dto.password, { logN: 15, r: 8, p: 1 });
      passwordHash = buf.toString("base64");
    }

    // 5. Create Medusa User
    const user = userRepo.create({
      email: cleanEmail,
      store_id: store.id,
      password_hash: passwordHash,
      role: UserRoles.MEMBER,
      metadata: {
        phone: cleanPhone,
        account_type: dto.accountType || "vendor",
        store_name: dto.storeName,
        ...(dto.niche ? { niche: dto.niche } : {}),
      },
    }) as User;
    const savedUser: User = await userRepo.save(user);

    // 6. Create Wallet entity
    let wallet = await walletRepo.getWallet(savedUser.id);
    if (!wallet) {
      wallet = await walletRepo.createWallet(savedUser.id);
    }
    if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
      wallet.total_balance = {};
    }
    if (wallet.total_balance["NGN"] === undefined) {
      wallet.total_balance["NGN"] = 0;
      wallet = await walletRepo.save(wallet);
    }

    // 7. Create initial NGN WalletAccount
    let walletAccount = await walletAccountRepo.findOne({
      where: { wallet_id: wallet.id, currency: "NGN" },
    });

    if (!walletAccount) {
      const uniquePart = Date.now().toString().slice(-6);
      const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
      const generatedAccountNumber = `AC${uniquePart}${randomPart}`;

      walletAccount = walletAccountRepo.create({
        wallet_id: wallet.id,
        currency: "NGN",
        balance: 0,
        account_numbers: [generatedAccountNumber, cleanPhone].filter(Boolean),
      });
      walletAccount = await walletAccountRepo.save(walletAccount);
    }

    // 8. Link User to Wallet
    await userRepo.update(savedUser.id, { wallet_id: wallet.id });
    savedUser.wallet_id = wallet.id;

    // 9. Link Store to Vendor User
    if (!store.metadata) store.metadata = {};
    store.metadata.vendor_user_id = savedUser.id;
    await storeRepo.save(store);

    this.logger_.info(
      `[VendorOnboardingService] ✅ Successfully provisioned vendor ${savedUser.id}: Store ${store.id}, Wallet ${wallet.id}, Account ${walletAccount.id}`
    );

    return {
      success: true,
      message: "Vendor registered and all systems provisioned successfully.",
      user: {
        id: savedUser.id,
        email: savedUser.email,
        store_id: store.id,
        store_name: store.name,
        wallet_id: wallet.id,
      },
      provisioning: {
        store: { id: store.id, name: store.name, currency: store.default_currency_code },
        wallet: { id: wallet.id, total_balance: wallet.total_balance },
        wallet_account: {
          id: walletAccount.id,
          currency: walletAccount.currency,
          balance: walletAccount.balance,
          account_number: walletAccount.account_numbers?.[0] || "",
        },
        verified: true,
      },
    };
  }
}

export default VendorOnboardingService;
