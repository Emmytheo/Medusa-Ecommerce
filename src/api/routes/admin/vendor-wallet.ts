import { Router, Request, Response } from "express";
import { MedusaContainer, MedusaRequest, MedusaResponse, User } from "@medusajs/medusa";
import PaystackService from "../../../services/paystack-service";
import OtpService from "../../../services/otp-service";
import VendorWalletService from "../../../services/vendor-wallet-service";

function getPaystackService(container: MedusaContainer): PaystackService {
  if (container.hasRegistration("paystackService")) {
    return container.resolve("paystackService");
  }
  if (container.hasRegistration("paystackServiceService")) {
    return container.resolve("paystackServiceService");
  }
  return new PaystackService(container);
}

function getOtpService(container: MedusaContainer): OtpService {
  if (container.hasRegistration("otpService")) {
    return container.resolve("otpService");
  }
  if (container.hasRegistration("otpServiceService")) {
    return container.resolve("otpServiceService");
  }
  return new OtpService(container);
}

function getVendorWalletService(container: MedusaContainer): VendorWalletService {
  if (container.hasRegistration("vendorWalletService")) {
    return container.resolve("vendorWalletService");
  }
  if (container.hasRegistration("vendorWalletServiceService")) {
    return container.resolve("vendorWalletServiceService");
  }
  return new VendorWalletService(container);
}

export default function vendorWalletRoutes(adminRouter: Router) {
  const router = Router();

  // Helper to ensure authenticated user with a linked store
  const getAuthenticatedVendor = async (req: MedusaRequest, res: MedusaResponse): Promise<{ user: User; storeId: string } | null> => {
    let user: any = null;
    try {
      user = req.scope.resolve("loggedInUser");
    } catch (_) {}

    if (!user) {
      user = req.user;
    }

    let userId = user?.id || (req as any).user?.id || (req as any).user?.userId || req.session?.user_id || req.headers["x-user-id"] || req.body?.user_id;
    const userService = req.scope.resolve("userService");

    // Fallback: look up user by email if provided
    const emailCandidate = req.body?.email || req.headers["x-user-email"] || req.query?.email;
    if (!userId && emailCandidate && typeof emailCandidate === "string") {
      try {
        const found = await userService.list({ email: emailCandidate.trim().toLowerCase() }, { take: 1 });
        if (found && found.length > 0) {
          user = found[0];
          userId = user.id;
        }
      } catch (_) {}
    }

    if (!userId) {
      res.status(401).json({ message: "Unauthorized. Please log in." });
      return null;
    }

    if (!user || !user.store_id || !user.id) {
      try {
        user = await userService.retrieve(userId, { relations: ["store", "wallet"] });
      } catch (err: any) {
        res.status(401).json({ message: "Unauthorized. User not found." });
        return null;
      }
    }

    const storeId = user.store_id || user.store?.id;
    if (!storeId) {
      res.status(400).json({ message: "No store linked to this vendor user account." });
      return null;
    }

    return { user, storeId };
  };

  /**
   * GET /admin/vendor/banks
   * Lists available banks for account resolution.
   */
  router.get("/banks", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const paystackService = getPaystackService(container);

    try {
      const country = (req.query.country as string) || "nigeria";
      const banks = await paystackService.listBanks(country);
      res.status(200).json({ banks });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to fetch bank list", error: error.message });
    }
  });

  /**
   * POST /admin/vendor/bank-account/resolve
   * Resolves account number with Paystack and returns verified account name.
   */
  router.post("/bank-account/resolve", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const paystackService = getPaystackService(container);

    const { account_number, bank_code } = req.body;

    if (!account_number || !bank_code) {
      res.status(400).json({ message: "account_number and bank_code are required" });
      return;
    }

    try {
      const resolved = await paystackService.resolveAccountNumber(account_number, bank_code);
      res.status(200).json({
        success: true,
        account_number: resolved.account_number,
        account_name: resolved.account_name,
        bank_id: resolved.bank_id,
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  /**
   * POST /admin/vendor/otp/send
   * Generates and dispatches OTP for sensitive wallet/bank operations.
   */
  router.post("/otp/send", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const otpService = getOtpService(container);

    const { purpose, phone_or_email } = req.body; // "bank_account_update" | "payout_request"
    const validPurpose = purpose || "general";
    const recipient = phone_or_email || (auth.user as any).metadata?.phone || (auth.user as any).phone || auth.user.email || "vendor";

    try {
      const result = await otpService.sendOtp(auth.user.id, recipient, validPurpose);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: "Failed to dispatch OTP", error: error.message });
    }
  });

  /**
   * GET /admin/vendor/bank-account
   * Retrieves the vendor's saved business bank account details.
   */
  router.get("/bank-account", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const vendorWalletService = getVendorWalletService(container);

    try {
      const overview = await vendorWalletService.getVendorWalletOverview(auth.user.id, auth.storeId);
      res.status(200).json({ bank_account: overview.bankAccount });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to retrieve bank account", error: error.message });
    }
  });

  /**
   * POST /admin/vendor/bank-account/save
   * Saves/Updates vendor bank account (requires OTP verification).
   */
  router.post("/bank-account/save", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const vendorWalletService = getVendorWalletService(container);

    const { bank_code, bank_name, account_number, otp_code } = req.body;

    if (!bank_code || !bank_name || !account_number || !otp_code) {
      res.status(400).json({ message: "bank_code, bank_name, account_number, and otp_code are all required." });
      return;
    }

    try {
      const saved = await vendorWalletService.saveVendorBankAccount(
        auth.user.id,
        auth.storeId,
        bank_code,
        bank_name,
        account_number,
        otp_code
      );
      res.status(200).json({
        success: true,
        message: "Business bank account verified and saved successfully.",
        bank_account: saved,
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  /**
   * GET /admin/vendor/wallet
   * Retrieves vendor wallet balance, accounts, and transaction history.
   */
  router.get("/wallet", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const vendorWalletService = getVendorWalletService(container);

    try {
      const overview = await vendorWalletService.getVendorWalletOverview(auth.user.id, auth.storeId);
      res.status(200).json(overview);
    } catch (error: any) {
      res.status(500).json({ message: "Failed to load wallet overview", error: error.message });
    }
  });

  /**
   * POST /admin/vendor/payout/request
   * Requests a payout / withdrawal (requires OTP verification).
   */
  router.post("/payout/request", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const vendorWalletService = getVendorWalletService(container);

    const { amount, currency = "ngn", otp_code } = req.body;

    if (!amount || !otp_code) {
      res.status(400).json({ message: "amount and otp_code are required" });
      return;
    }

    try {
      const payout = await vendorWalletService.requestPayout(
        auth.user.id,
        auth.storeId,
        Number(amount),
        currency,
        otp_code
      );
      res.status(200).json({
        success: true,
        message: "Payout request submitted successfully.",
        payout,
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  /**
   * GET /admin/vendor/payouts
   * Lists payout history for the vendor's store.
   */
  router.get("/payouts", async (req: MedusaRequest, res: MedusaResponse) => {
    const auth = await getAuthenticatedVendor(req, res);
    if (!auth) return;

    const container: MedusaContainer = req.scope;
    const vendorWalletService = getVendorWalletService(container);

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    try {
      const [payouts, count] = await vendorWalletService.listPayouts(auth.storeId, limit, offset);
      res.status(200).json({
        payouts,
        count,
        limit,
        offset,
      });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to fetch payouts", error: error.message });
    }
  });

  adminRouter.use("/vendor", router);
}
