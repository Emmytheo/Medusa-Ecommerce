import { PaystackService } from "../paystack-service";
import { OtpService } from "../otp-service";
import { VendorOnboardingService } from "../vendor-onboarding-service";

describe("PaystackService & OtpService Tests", () => {
  let otpService: OtpService;
  let onboardingService: VendorOnboardingService;

  beforeEach(() => {
    const mockRepo = {
      invalidateUserOtps: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((dto) => ({ ...dto, id: "otp_test_123" })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findValidOtp: jest.fn((userId, purpose, code) => {
        if (code === "654321") {
          return Promise.resolve({
            id: "otp_test_123",
            user_id: userId,
            purpose,
            code,
            is_used: false,
            expires_at: new Date(Date.now() + 600000),
          });
        }
        return Promise.resolve(null);
      }),
    };

    const mockUserRepo = {
      findOne: jest.fn(({ where }) => {
        if (where?.email === "used@afriomarkets.com") {
          return Promise.resolve({ id: "usr_used_1", email: "used@afriomarkets.com" });
        }
        return Promise.resolve(null);
      }),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => Promise.resolve(null)),
      })),
      create: jest.fn((dto) => ({ ...dto, id: "usr_new_1" })),
      save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || "usr_new_1" })),
    };

    const mockStoreRepo = {
      create: jest.fn((dto) => ({ ...dto, id: "store_new_1" })),
      save: jest.fn((entity) => Promise.resolve({ ...entity, id: "store_new_1" })),
    };

    const mockWalletRepo = {
      getWallet: jest.fn().mockResolvedValue(null),
      createWallet: jest.fn((userId) => Promise.resolve({ id: "wallet_new_1", user_id: userId })),
    };

    const mockWalletAccountRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((dto) => ({ ...dto, id: "wa_new_1" })),
      save: jest.fn((entity) => Promise.resolve({ ...entity, id: "wa_new_1" })),
    };

    const mockManager = {
      withRepository: jest.fn((repo) => {
        if (repo === mockUserRepo) return mockUserRepo;
        if (repo === mockStoreRepo) return mockStoreRepo;
        if (repo === mockWalletRepo) return mockWalletRepo;
        if (repo === mockWalletAccountRepo) return mockWalletAccountRepo;
        return mockRepo;
      }),
    };

    const container: Record<string, any> = {
      manager: mockManager,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      otpVerificationRepository: mockRepo,
      userRepository: mockUserRepo,
      storeRepository: mockStoreRepo,
      walletRepository: mockWalletRepo,
      walletAccountRepository: mockWalletAccountRepo,
    };

    otpService = new OtpService(container);
    container["otpService"] = otpService;
    onboardingService = new VendorOnboardingService(container);
  });

  it("should generate a 6-digit OTP and calculate expiry", async () => {
    const res = await otpService.sendOtp("usr_test_1", "test@afriomarkets.com", "bank_account_update");
    expect(res.success).toBe(true);
    expect(res.phoneOrEmail).toBe("test@afriomarkets.com");
    expect(res.expiresInSeconds).toBe(600);
  });

  it("should verify valid OTP successfully", async () => {
    const isValid = await otpService.verifyOtp("usr_test_1", "bank_account_update", "654321");
    expect(isValid).toBe(true);
  });

  it("should reject invalid OTP", async () => {
    const isValid = await otpService.verifyOtp("usr_test_1", "bank_account_update", "999999");
    expect(isValid).toBe(false);
  });

  it("should accept standard test bypass codes in dev", async () => {
    const isValidBypass = await otpService.verifyOtp("usr_test_1", "bank_account_update", "123456");
    expect(isValidBypass).toBe(true);
  });

  it("should detect already registered email during onboarding pre-check", async () => {
    const check = await onboardingService.checkAvailability(undefined, "used@afriomarkets.com");
    expect(check.available).toBe(false);
    expect(check.isEmailUsed).toBe(true);
  });

  it("should confirm available phone/email during onboarding pre-check", async () => {
    const check = await onboardingService.checkAvailability("+2348012345678", "fresh@afriomarkets.com");
    expect(check.available).toBe(true);
  });

  it("should register a new vendor with store, user, and wallet", async () => {
    const res = await onboardingService.registerVendor({
      email: "fresh@afriomarkets.com",
      password: "Password123!",
      storeName: "Fresh Lagos Market",
      phone: "+2348012345678",
      accountType: "vendor",
      otpCode: "123456",
    });

    expect(res.success).toBe(true);
    expect(res.user.email).toBe("fresh@afriomarkets.com");
    expect(res.user.store_id).toBe("store_new_1");
  });
});
