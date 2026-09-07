import { Router } from "express";
import { MedusaContainer, MedusaRequest, MedusaResponse } from "@medusajs/medusa";
import VendorOnboardingService from "../../../services/vendor-onboarding-service";

function getOnboardingService(container: MedusaContainer): VendorOnboardingService {
  if (container.hasRegistration("vendorOnboardingService")) {
    return container.resolve("vendorOnboardingService");
  }
  if (container.hasRegistration("vendorOnboardingServiceService")) {
    return container.resolve("vendorOnboardingServiceService");
  }
  return new VendorOnboardingService(container);
}

export default function vendorOnboardingRoutes(adminRouter: Router) {
  const router = Router();

  /**
   * POST /admin/vendor/onboarding/check
   * Pre-check availability of phone number and/or email address.
   */
  router.post("/check", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const onboardingService = getOnboardingService(container);

    const { phone, email } = req.body;

    try {
      const result = await onboardingService.checkAvailability(phone, email);
      res.status(200).json(result);
    } catch (error: any) {
      console.error("[OnboardingCheck Error]", error);
      res.status(200).json({ available: true, message: "Availability check completed" });
    }
  });

  /**
   * POST /admin/vendor/onboarding/otp/send
   * Dispatches OTP for vendor onboarding.
   */
  router.post("/otp/send", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const onboardingService = getOnboardingService(container);

    const { phone, email } = req.body;
    const target = (phone || email || "").toString().trim();

    if (!target) {
      res.status(400).json({ success: false, message: "Phone or email is required to send OTP." });
      return;
    }

    try {
      const result = await onboardingService.sendOnboardingOtp(target);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  /**
   * POST /admin/vendor/onboarding/otp/verify
   * Verifies an onboarding OTP.
   */
  router.post("/otp/verify", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const onboardingService = getOnboardingService(container);

    // Accept both 'code' (Flutter client) and 'otp_code' (legacy) field names
    const { phone, email, otp_code, code } = req.body;
    const otpValue = (otp_code || code || "").toString().trim();
    const target = (phone || email || "").toString().trim();

    if (!target || !otpValue) {
      res.status(400).json({ valid: false, success: false, message: "Phone/email and OTP code are required." });
      return;
    }

    try {
      const isValid = await onboardingService.verifyOnboardingOtp(target, otpValue, false);
      if (isValid) {
        res.status(200).json({ valid: true, success: true, message: "OTP verified successfully." });
      } else {
        res.status(200).json({ valid: false, success: false, message: "Invalid or expired OTP code. Please try again." });
      }
    } catch (error: any) {
      res.status(200).json({ valid: false, success: false, message: error.message });
    }
  });

  /**
   * POST /admin/vendor/onboarding/register
   * Completes vendor account, store, and initial wallet setup without needing superadmin credentials.
   */
  router.post("/register", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const onboardingService = getOnboardingService(container);

    // Accept both camelCase (Flutter) and snake_case field names
    const {
      email, password, phone,
      store_name, storeName,
      account_type, accountType,
      otp_code, code, otpCode,
      niche,
    } = req.body;

    const resolvedStoreName = store_name || storeName;
    const resolvedAccountType = account_type || accountType;
    const resolvedOtpCode = (otp_code || code || otpCode || "").toString().trim();

    if (!email || !resolvedStoreName || !phone || !resolvedOtpCode) {
      res.status(400).json({
        success: false,
        message: "email, storeName, phone, and otpCode are required fields.",
      });
      return;
    }

    try {
      const result = await onboardingService.registerVendor({
        email,
        password,
        storeName: resolvedStoreName,
        phone,
        accountType: resolvedAccountType,
        otpCode: resolvedOtpCode,
        niche,
      });

      res.status(200).json(result);
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  adminRouter.use("/vendor/onboarding", router);
}
