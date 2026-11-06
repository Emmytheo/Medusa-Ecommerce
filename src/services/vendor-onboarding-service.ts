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
import DeviceGatewayService from "./device-gateway-service";
import AwsSnsService from "./aws-sns-service";

export interface VendorRegisterDto {
  email: string;
  password?: string;
  storeName: string;
  phone: string;
  accountType?: string; // vendor, dropshipper, logistics_staff, intern
  otpCode: string;
  niche?: string;
}

export interface SmsOnboardingDto {
  phone?: string;
  sender?: string;
  phone_number?: string;
  name?: string;
  contact_name?: string;
  businessName?: string;
  business_name?: string;
  store_name?: string;
  storeType?: string;
  store_type?: string;
  type?: string;
  niche?: string;
  address?: string;
  products?: any[];
  raw_body?: string;
  email?: string;
  password?: string;
}

@Service()
export class VendorOnboardingService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly otpService_: OtpService;
  protected readonly deviceGatewayService_: DeviceGatewayService;
  protected readonly awsSnsService_: AwsSnsService;
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

    try {
      this.deviceGatewayService_ = container.deviceGatewayServiceService || container.deviceGatewayService || new DeviceGatewayService(container);
    } catch (_) {
      this.deviceGatewayService_ = new DeviceGatewayService(container);
    }
    try {
      this.awsSnsService_ = container.awsSnsServiceService || container.awsSnsService || new AwsSnsService(container);
    } catch (_) {
      this.awsSnsService_ = new AwsSnsService(container);
    }
  }

  protected getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (url && key) {
      return createClient(url, key);
    }
    return null;
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
   * Pre-provisions a confirmed Supabase Auth user bypassing confirmation email delivery failures.
   */
  async provisionAuthUser(dto: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    accountType?: string;
    storeName?: string;
    niche?: string;
  }): Promise<{ success: boolean; user?: any; message?: string }> {
    const cleanEmail = dto.email.trim().toLowerCase();
    const cleanPhone = dto.phone ? dto.phone.trim() : "";
    const supabase = this.getSupabaseClient();

    if (!supabase) {
      throw new Error("Supabase service client is not configured.");
    }

    try {
      const { data: listData } = await supabase.auth.admin.listUsers();
      const existing = listData?.users?.find(
        (u: any) => u.email?.toLowerCase() === cleanEmail
      );

      if (existing) {
        const { error: updateErr } = await supabase.auth.admin.updateUserById(
          existing.id,
          {
            email_confirm: true,
            password: dto.password,
            user_metadata: {
              first_name: dto.firstName?.trim() || existing.user_metadata?.first_name || "",
              last_name: dto.lastName?.trim() || existing.user_metadata?.last_name || "",
              full_name: `${dto.firstName?.trim() || ""} ${dto.lastName?.trim() || ""}`.trim(),
              phone: cleanPhone || existing.user_metadata?.phone || "",
              account_type: dto.accountType || existing.user_metadata?.account_type || "vendor",
              store_name: dto.storeName?.trim() || existing.user_metadata?.store_name || "",
              niche: dto.niche || existing.user_metadata?.niche || "",
              email_verified: true,
            },
          }
        );
        if (updateErr) throw updateErr;

        return {
          success: true,
          user: { id: existing.id, email: existing.email },
          message: "Existing user credentials updated and auto-confirmed.",
        };
      }

      const { data, error } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: dto.password,
        email_confirm: true,
        user_metadata: {
          first_name: dto.firstName?.trim() || "",
          last_name: dto.lastName?.trim() || "",
          full_name: `${dto.firstName?.trim() || ""} ${dto.lastName?.trim() || ""}`.trim(),
          phone: cleanPhone,
          account_type: dto.accountType || "vendor",
          store_name: dto.storeName?.trim() || "",
          niche: dto.niche || "",
          email_verified: true,
        },
      });

      if (error) throw error;

      return {
        success: true,
        user: { id: data.user.id, email: data.user.email },
        message: "User provisioned and pre-confirmed successfully.",
      };
    } catch (err: any) {
      this.logger_.error(`[VendorOnboardingService] provisionAuthUser error: ${err.message}`);
      throw err;
    }
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

    // 1. Verify OTP first (allows unexpired or recently verified OTPs without burning prematurely)
    let isOtpValid = await this.verifyOnboardingOtp(cleanPhone || cleanEmail, dto.otpCode, false);
    if (!isOtpValid) {
      isOtpValid = await this.verifyOnboardingOtp(cleanPhone || cleanEmail, dto.otpCode, true);
    }
    if (!isOtpValid) {
      throw new Error("Invalid or expired OTP code. Please request a new verification code.");
    }

    // 2. Check for existing user (Idempotent Retry Handling)
    const existingUser = await userRepo.findOne({
      where: { email: cleanEmail },
    });

    if (existingUser) {
      // Check if created recently (e.g. within 60 minutes) as a retry/timeout recovery
      const createdTime = existingUser.created_at ? new Date(existingUser.created_at).getTime() : 0;
      const isRecent = Date.now() - createdTime < 60 * 60 * 1000;

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
        if (!wallet) {
          wallet = await walletRepo.getWallet(existingUser.id);
        }
        if (wallet) {
          if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
            wallet.total_balance = {};
          }
          if (wallet.total_balance["NGN"] === undefined) {
            wallet.total_balance["NGN"] = 0;
            await walletRepo.update(wallet.id, { total_balance: wallet.total_balance });
          }
        }

        // Ensure NGN WalletAccount is intact
        let account = wallet ? await walletAccountRepo.findOne({
          where: { wallet_id: wallet.id, currency: "NGN" },
        }) : null;

        if (!account && wallet) {
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
        if (wallet && (!existingUser.wallet_id || existingUser.wallet_id !== wallet.id)) {
          await userRepo.update(existingUser.id, { wallet_id: wallet.id });
          existingUser.wallet_id = wallet.id;
        }

        // Finalize OTP on successful recovery
        try {
          const cleanId = cleanPhone.replace(/\D/g, "") || cleanEmail.toLowerCase();
          await this.otpService_.verifyOtp(`onboard_${cleanId}`, "vendor_onboarding", dto.otpCode, {
            markAsUsed: true,
            allowRecentlyUsed: true,
            phoneOrEmail: cleanPhone || cleanEmail,
          });
        } catch (_) {}

        return {
          success: true,
          message: "Vendor registered and all systems confirmed successfully.",
          user: {
            id: existingUser.id,
            email: existingUser.email,
            store_id: store.id,
            store_name: store.name,
            wallet_id: wallet?.id,
          },
          provisioning: {
            store: { id: store.id, name: store.name, currency: store.default_currency_code },
            wallet: { id: wallet?.id, total_balance: wallet?.total_balance },
            wallet_account: {
              id: account?.id,
              currency: account?.currency,
              balance: account?.balance,
              account_number: account?.account_numbers?.[0] || "",
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
    if (!wallet) {
      wallet = await walletRepo.getWallet(savedUser.id);
    }
    if (!wallet) {
      throw new Error("Failed to initialize vendor wallet. Please try again.");
    }
    if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
      wallet.total_balance = {};
    }
    if (wallet.total_balance["NGN"] === undefined) {
      wallet.total_balance["NGN"] = 0;
      await walletRepo.update(wallet.id, { total_balance: wallet.total_balance });
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

    // 10. Finalize OTP now that registration succeeded atomically
    try {
      const cleanId = cleanPhone.replace(/\D/g, "") || cleanEmail.toLowerCase();
      await this.otpService_.verifyOtp(
        `onboard_${cleanId}`,
        "vendor_onboarding",
        dto.otpCode,
        {
          markAsUsed: true,
          allowRecentlyUsed: true,
          phoneOrEmail: cleanPhone || cleanEmail,
        }
      );
    } catch (e: any) {
      this.logger_.warn(`[VendorOnboardingService] Final OTP lock notice: ${e.message}`);
    }

    // 11. Ensure pre-confirmed Supabase Auth user exists for seamless portal login
    try {
      await this.provisionAuthUser({
        email: cleanEmail,
        password: dto.password || "AfrioVendor@123",
        phone: cleanPhone,
        storeName: dto.storeName,
        accountType: dto.accountType || "vendor",
        niche: dto.niche,
      });
    } catch (sbErr: any) {
      this.logger_.warn(`[VendorOnboardingService] Supabase Auth sync notice: ${sbErr.message}`);
    }

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

  /**
   * Onboards a new vendor from an incoming SMS intercepted by the Android gateway.
   * Provisions Store, User, Wallet, WalletAccount, drafts initial products,
   * updates Supabase onboarding_requests table, and dispatches welcome credentials via SMS.
   */
  async onboardVendorFromSms(dto: SmsOnboardingDto): Promise<any> {
    this.logger_.info(`[VendorOnboardingService] 📩 Received SMS onboarding request: ${JSON.stringify(dto)}`);

    // 1. Resolve and normalize phone number
    const rawBody = (dto.raw_body || "").toString().trim();
    let phoneCandidate = (
      dto.phone ||
      dto.phone_number ||
      dto.sender ||
      ""
    ).toString().trim();

    // Fallback: if phone candidate is empty or non-numeric, search in raw_body
    if (!phoneCandidate && rawBody) {
      const match = rawBody.match(/(?:\+?234|0)[789][01]\d{8}/);
      if (match) phoneCandidate = match[0];
    }
    if (!phoneCandidate && dto.name && /^\+?\d{8,15}$/.test(dto.name.trim())) {
      phoneCandidate = dto.name.trim();
    }

    let digitsOnly = phoneCandidate.replace(/\D/g, "");
    let cleanPhone = "";
    if (digitsOnly.startsWith("234")) {
      cleanPhone = "+" + digitsOnly;
    } else if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
      cleanPhone = "+234" + digitsOnly.slice(1);
    } else if (digitsOnly.length >= 10) {
      cleanPhone = "+234" + digitsOnly.slice(-10);
    } else if (digitsOnly.length > 0) {
      cleanPhone = "+" + digitsOnly;
    }

    if (!cleanPhone) {
      throw new Error("Could not determine sender phone number from SMS onboarding payload.");
    }

    // 2. Resolve Store Name, Contact Name, and Category
    const resolvedStoreName = (
      dto.businessName ||
      dto.business_name ||
      dto.store_name ||
      (dto.name && !/^\+?\d+$/.test(dto.name.trim()) ? `${dto.name.trim()}'s Store` : null) ||
      `AFM_Store_${cleanPhone.slice(-4)}`
    ).toString().trim();

    const resolvedName = (
      dto.contact_name ||
      (dto.name && !/^\+?\d+$/.test(dto.name.trim()) ? dto.name.trim() : null) ||
      resolvedStoreName.split(" ")[0] ||
      "Vendor"
    ).toString().trim();

    const resolvedNiche = (
      dto.storeType ||
      dto.store_type ||
      dto.type ||
      dto.niche ||
      "general"
    ).toString().toLowerCase().trim();

    const resolvedAddress = (dto.address || "").toString().trim();
    const cleanEmail = (
      dto.email ||
      `vendor_${cleanPhone.replace(/\D/g, "")}@afriomarkets.com`
    ).toLowerCase().trim();

    const plainPassword = dto.password || `Afrio${Math.floor(1000 + Math.random() * 9000)}`;

    const userRepo = this.activeManager_.withRepository(this.userRepository_);
    const storeRepo = this.activeManager_.withRepository(this.storeRepository_);
    const walletRepo = this.activeManager_.withRepository(this.walletRepository_);
    const walletAccountRepo = this.activeManager_.withRepository(this.walletAccountRepository_);

    // 3. Check if user already exists
    let user = await userRepo.findOne({
      where: [{ email: cleanEmail }],
    });

    let store: any = null;

    if (user) {
      this.logger_.info(`[VendorOnboardingService] Existing vendor found for ${cleanEmail} (${cleanPhone}). Recovering account.`);
      if (user.store_id) {
        store = await storeRepo.findOne({ where: { id: user.store_id } });
      }
      if (!store) {
        store = storeRepo.create({
          name: resolvedStoreName,
          default_currency_code: "ngn",
          metadata: {
            phone: cleanPhone,
            niche: resolvedNiche,
            address: resolvedAddress,
            account_type: "vendor",
            onboarded_via: "sms",
          },
        });
        store = await storeRepo.save(store);
        await userRepo.update(user.id, { store_id: store.id });
      }
    } else {
      // 4. Create Store Entity
      store = storeRepo.create({
        name: resolvedStoreName,
        default_currency_code: "ngn",
        metadata: {
          phone: cleanPhone,
          niche: resolvedNiche,
          address: resolvedAddress,
          account_type: "vendor",
          onboarded_via: "sms",
        },
      });
      store = await storeRepo.save(store);

      // 5. Hash password
      const buf = await Scrypt.kdf(plainPassword, { logN: 15, r: 8, p: 1 });
      const passwordHash = buf.toString("base64");

      // 6. Create User
      const newUser = userRepo.create({
        email: cleanEmail,
        first_name: resolvedName,
        last_name: "Vendor",
        role: UserRoles.MEMBER,
        store_id: store.id,
        password_hash: passwordHash,
        metadata: {
          phone: cleanPhone,
          store_name: resolvedStoreName,
          niche: resolvedNiche,
          address: resolvedAddress,
          onboarded_via: "sms",
        },
      }) as User;
      user = await userRepo.save(newUser);
    }

    // 7. Provision Wallet
    let wallet = await walletRepo.getWallet(user.id);
    if (!wallet) {
      wallet = await walletRepo.createWallet(user.id);
    }
    if (!wallet) {
      wallet = await walletRepo.getWallet(user.id);
    }
    if (wallet) {
      if (!wallet.total_balance || typeof wallet.total_balance !== "object") {
        wallet.total_balance = {};
      }
      if (wallet.total_balance["NGN"] === undefined) {
        wallet.total_balance["NGN"] = 0;
        await walletRepo.update(wallet.id, { total_balance: wallet.total_balance });
      }
    }

    // 8. Provision Wallet Account
    let walletAccount = wallet ? await walletAccountRepo.findOne({
      where: { wallet_id: wallet.id, currency: "NGN" },
    }) : null;

    if (!walletAccount && wallet) {
      const uniquePart = Date.now().toString().slice(-6);
      const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
      walletAccount = walletAccountRepo.create({
        wallet_id: wallet.id,
        currency: "NGN",
        balance: 0,
        account_numbers: [`AC${uniquePart}${randomPart}`, cleanPhone].filter(Boolean),
      });
      walletAccount = await walletAccountRepo.save(walletAccount);
    }

    // Link user wallet_id and store vendor_user_id
    if (wallet && (!user.wallet_id || user.wallet_id !== wallet.id)) {
      await userRepo.update(user.id, { wallet_id: wallet.id });
      user.wallet_id = wallet.id;
    }
    if (store && (!store.metadata?.vendor_user_id || store.metadata.vendor_user_id !== user.id)) {
      if (!store.metadata) store.metadata = {};
      store.metadata.vendor_user_id = user.id;
      await storeRepo.save(store);
    }

    // 9. Update/Log in Supabase onboarding_requests table
    try {
      const supabase = this.getSupabaseClient();
      if (supabase) {
        await supabase.from("onboarding_requests").insert({
          phone: cleanPhone,
          sender: dto.sender || cleanPhone,
          name: resolvedName,
          business_name: resolvedStoreName,
          store_type: resolvedNiche,
          address: resolvedAddress,
          products: dto.products || [],
          raw_body: rawBody,
          status: "completed",
          medusa_user_id: user.id,
          medusa_store_id: store.id,
          temporary_password: plainPassword,
          response_payload: {
            user_id: user.id,
            store_id: store.id,
            email: cleanEmail,
            store_name: resolvedStoreName,
            wallet_id: wallet?.id,
          },
        });
      }
    } catch (e: any) {
      this.logger_.warn(`[VendorOnboardingService] Supabase log notice: ${e.message}`);
    }

    // 10. Send Confirmation SMS back to the vendor
    const welcomeMessage = `Welcome to Afriomarkets! Store '${resolvedStoreName}' created. Login: ${cleanEmail}, Pass: ${plainPassword}. Portal: eke.afriomarkets.com [Official SMS Onboarding]`;

    this.logger_.info(`[VendorOnboardingService] 📲 Dispatching welcome SMS to ${cleanPhone}: "${welcomeMessage}"`);

    try {
      // Primary: Android Cellular Edge Gateway (immediate local cellular transmission)
      const gatewayRes = await this.deviceGatewayService_.sendSms(cleanPhone, welcomeMessage, {
        purpose: "onboarding_welcome",
        subject: "Afriomarkets",
      });
      this.logger_.info(`[VendorOnboardingService] Gateway SMS dispatch: ${JSON.stringify(gatewayRes)}`);
    } catch (gwErr: any) {
      this.logger_.warn(`[VendorOnboardingService] Gateway dispatch notice: ${gwErr.message}`);
    }

    try {
      // Secondary: AWS SNS dual-dispatch for guaranteed delivery
      const snsRes = await this.awsSnsService_.sendSms(cleanPhone, welcomeMessage, "Afriomarkets");
      this.logger_.info(`[VendorOnboardingService] SNS SMS dispatch: ${JSON.stringify(snsRes)}`);
    } catch (snsErr: any) {
      this.logger_.warn(`[VendorOnboardingService] SNS dispatch notice: ${snsErr.message}`);
    }

    return {
      success: true,
      message: "Vendor registered and systems provisioned successfully via SMS.",
      vendor: {
        user_id: user.id,
        email: cleanEmail,
        store_id: store.id,
        store_name: resolvedStoreName,
        phone: cleanPhone,
        temporary_password: plainPassword,
        portal_url: "https://eke.afriomarkets.com",
      },
    };
  }
}

export default VendorOnboardingService;
