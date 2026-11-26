import { Router } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import crypto from "crypto";
import { authenticate, ConfigModule } from "@medusajs/medusa";
import { getConfigFile } from "medusa-core-utils";
import { authenticateAdminOrSupabase, registerLoggedInUser } from "./middlewares/logged-in-user";
import { attachStoreRoutes } from "./routes/store";
import { attachAdminRoutes } from "./routes/admin";
import CustomManualFulfillmentService from "../services/custom-fufillment-manual";

export default (rootDirectory: string): Router | Router[] => {
  // Ensure Medusa's store & admin product endpoints always return store_id for authentic stall attribution
  try {
    const storeProductsImports = require("@medusajs/medusa/dist/api/routes/store/products/index");
    if (Array.isArray(storeProductsImports.defaultStoreProductsFields) && !storeProductsImports.defaultStoreProductsFields.includes("store_id")) {
      storeProductsImports.defaultStoreProductsFields.push("store_id");
    }
    if (Array.isArray(storeProductsImports.allowedStoreProductsFields) && !storeProductsImports.allowedStoreProductsFields.includes("store_id")) {
      storeProductsImports.allowedStoreProductsFields.push("store_id");
    }
    if (Array.isArray(storeProductsImports.allowedStoreProductsRelations) && !storeProductsImports.allowedStoreProductsRelations.includes("store")) {
      storeProductsImports.allowedStoreProductsRelations.push("store");
    }
  } catch (_) {}

  // Read currently-loaded medusa config
  const { configModule } = getConfigFile<ConfigModule>(
    rootDirectory,
    "medusa-config"
  );
  const { projectConfig } = configModule;

  const isAllowedOrigin = (origin: string | undefined, configuredList: string) => {
    if (!origin) return true;
    const configured = (configuredList || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (configured.includes(origin)) return true;
    if (
      /^https?:\/\/localhost(:\d+)?$/i.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin) ||
      /^https:\/\/([a-z0-9-]+\.)*afriomarkets\.com$/i.test(origin) ||
      /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin)
    ) {
      return true;
    }
    return false;
  };

  // Set up our CORS options objects, based on config + dynamic Afriomarkets/Vercel domains
  const storeCorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (isAllowedOrigin(origin, projectConfig.store_cors)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  };

  const adminCorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (isAllowedOrigin(origin, projectConfig.admin_cors)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  };

  // Set up express router
  const router = Router();

  // Set up root routes for store and admin endpoints, with appropriate CORS settings
  router.use("/store", cors(storeCorsOptions), bodyParser.json());
  router.use("/admin", cors(adminCorsOptions), bodyParser.json());

  // Pre-handler middleware to harden Paystack webhooks (/paystack/hooks, /store/paystack/hooks, /hooks/paystack)
  const paystackWebhookPreHandler = async (req: any, res: any, next: any) => {
    if (req.method !== "POST") return next();
    try {
      const secret = process.env.PS_KEY || process.env.PAYSTACK_SECRET_KEY || "";
      if (!secret) {
        console.error("Paystack Webhook Error: No PS_KEY configured");
        return next();
      }

      const signature = req.headers["x-paystack-signature"];
      if (!signature || !req.body) {
        return next();
      }

      const computedHash = crypto
        .createHmac("sha512", secret)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (computedHash !== signature) {
        return res.status(400).send("Invalid signature");
      }

      const event = req.body.event;
      const data = req.body.data || {};
      req.body.data = data;

      // Ensure data.metadata is always a non-null object so medusa-payment-paystack never crashes on data.metadata.cart_id
      if (!data.metadata || typeof data.metadata !== "object") {
        if (typeof data.metadata === "string") {
          try {
            data.metadata = JSON.parse(data.metadata);
          } catch {
            data.metadata = {};
          }
        } else {
          data.metadata = {};
        }
      }

      // Check custom_fields fallback for cart_id
      if (!data.metadata.cart_id && Array.isArray(data.metadata.custom_fields)) {
        const cf = data.metadata.custom_fields.find(
          (f: any) => f?.variable_name === "cart_id" || f?.display_name === "cart_id"
        );
        if (cf?.value) {
          data.metadata.cart_id = cf.value;
        }
      }

      const manager = req.scope?.resolve ? req.scope.resolve("manager") : null;

      // Fallback: if cart_id is still missing on charge.success, look it up in payment_session by paystackTxRef
      if (event === "charge.success" && !data.metadata.cart_id && data.reference && manager) {
        try {
          const rows = await manager.query(
            `SELECT cart_id FROM payment_session WHERE provider_id = 'paystack' AND (data->>'paystackTxRef' = $1 OR data->'paystackTxAuthData'->>'reference' = $1) ORDER BY created_at DESC LIMIT 1`,
            [String(data.reference)]
          );
          if (rows && rows.length > 0 && rows[0].cart_id) {
            data.metadata.cart_id = rows[0].cart_id;
            console.info(
              `Paystack Webhook: Resolved cart_id ${rows[0].cart_id} from payment_session for reference ${data.reference}`
            );
          }
        } catch (lookupErr) {
          console.warn("Paystack Webhook: Failed to lookup cart_id by reference:", lookupErr);
        }
      }

      // Handle Paystack Transfer Webhooks for Vendor Payouts (transfer.success / transfer.failed / transfer.reversed)
      if (
        manager &&
        (event === "transfer.success" ||
          event === "transfer.failed" ||
          event === "transfer.reversed")
      ) {
        const newStatus = event === "transfer.success" ? "completed" : "failed";
        const ref = data.reference ? String(data.reference) : null;
        const transferCode = data.transfer_code ? String(data.transfer_code) : null;
        if (ref || transferCode) {
          try {
            await manager.query(
              `UPDATE vendor_payout SET status = $1, updated_at = NOW() WHERE (reference = $2 OR transfer_code = $3) AND status = 'processing'`,
              [newStatus, ref || "", transferCode || ""]
            );
            console.info(
              `Paystack Webhook: Updated vendor_payout (${ref || transferCode}) to status=${newStatus}`
            );
          } catch (payoutErr) {
            console.warn("Paystack Webhook: Error updating vendor_payout status:", payoutErr);
          }
        }
      }

      // Safety net: if charge.success has a cart_id, schedule a fallback check after 7s in case delayed eventBus doesn't complete the cart
      if (event === "charge.success" && data.metadata?.cart_id && req.scope) {
        const cartId = data.metadata.cart_id;
        const scope = req.scope;
        setTimeout(async () => {
          try {
            const orderService = scope.resolve("orderService");
            const existingOrder = await orderService
              .retrieveByCartId(cartId)
              .catch(() => null);
            if (existingOrder) return;

            const dbManager = scope.resolve("manager");
            const completionStrategy = scope.resolve("cartCompletionStrategy");
            const cartService = scope.resolve("cartService");
            const idempotencyKeyService = scope.resolve("idempotencyKeyService");

            await dbManager.transaction(async (txManager: any) => {
              let idempotencyKey = await idempotencyKeyService
                .withTransaction(txManager)
                .retrieve({ idempotency_key: cartId })
                .catch(() => null);
              if (!idempotencyKey) {
                idempotencyKey = await idempotencyKeyService
                  .withTransaction(txManager)
                  .create({ idempotency_key: cartId });
              }
              const cart = await cartService
                .withTransaction(txManager)
                .retrieve(cartId, { select: ["context"] });
              await completionStrategy
                .withTransaction(txManager)
                .complete(cartId, idempotencyKey, { ip: cart?.context?.ip });
            });
            console.info(`Paystack Webhook Fallback: Completed cart ${cartId}`);
          } catch (fallbackErr) {
            // Order was likely already completed by the primary subscriber
          }
        }, 7000);
      }
    } catch (err) {
      console.error("Paystack Webhook PreHandler Error:", err);
    }
    return next();
  };

  router.post("/paystack/hooks", bodyParser.json(), paystackWebhookPreHandler);

  // Alias /store/paystack/hooks and /hooks/paystack to /paystack/hooks for convenience
  router.post("/store/paystack/hooks", bodyParser.json(), (req, res, next) => {
    req.url = "/paystack/hooks";
    (router as any).handle(req, res, next);
  });
  router.post("/hooks/paystack", bodyParser.json(), (req, res, next) => {
    req.url = "/paystack/hooks";
    (router as any).handle(req, res, next);
  });

  // Live Paystack Transaction Verification Endpoint (/store/paystack/verify?reference=...)
  const handlePaystackVerify = async (req: any, res: any) => {
    try {
      const reference =
        req.query?.reference ||
        req.query?.trxref ||
        req.body?.reference ||
        req.body?.trxref;
      if (!reference) {
        return res.status(400).json({
          status: false,
          message: "Transaction reference is required",
        });
      }

      const secret = process.env.PS_KEY || process.env.PAYSTACK_SECRET_KEY || "";
      if (!secret) {
        return res.status(500).json({
          status: false,
          message: "Paystack secret key is not configured on the server",
        });
      }

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(String(reference))}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
        }
      );
      const result: any = await response.json();

      return res.status(response.ok ? 200 : 400).json({
        status: Boolean(result?.status),
        verified: result?.data?.status === "success",
        message: result?.message || "Verification completed",
        data: result?.data || null,
      });
    } catch (err: any) {
      return res.status(500).json({
        status: false,
        verified: false,
        message: err?.message || "Failed to verify Paystack transaction",
      });
    }
  };

  router.get("/store/paystack/verify", cors(storeCorsOptions), handlePaystackVerify);
  router.post("/store/paystack/verify", cors(storeCorsOptions), bodyParser.json(), handlePaystackVerify);

  // ── Customer Forgot Password & OTP Recovery Endpoints ─────────────────────
  const maskEmailAddress = (email?: string | null): string | null => {
    if (!email || !email.includes("@")) return null;
    const [local, domain] = email.split("@");
    if (local.length <= 2) {
      return `${local[0] || "*"}***@${domain}`;
    }
    return `${local[0]}${"*".repeat(Math.min(4, local.length - 2))}${local[local.length - 1]}@${domain}`;
  };

  const maskPhoneNumber = (phone?: string | null): string | null => {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 7) return null;
    const last4 = digits.slice(-4);
    const prefix = digits.startsWith("234") ? "+234" : digits.startsWith("0") ? "0" : `+${digits.slice(0, 3)}`;
    return `${prefix} *** *** ${last4}`;
  };

  const findRegisteredCustomerByIdentifier = async (req: any, rawIdentifier: string) => {
    const cleaned = String(rawIdentifier || "")
      .replace(/[\u200e\u200f\u202a-\u202e\u00a0]/g, "")
      .trim();
    if (!cleaned) return null;

    const manager = req.scope.resolve("manager");
    const isEmail = cleaned.includes("@");

    if (isEmail) {
      const rows = await manager.query(
        `SELECT id, email, first_name, last_name, phone, has_account, password_hash
         FROM customer
         WHERE LOWER(email) = LOWER($1)
           AND has_account = true
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [cleaned]
      );
      return rows?.[0] || null;
    }

    const digits = cleaned.replace(/\D/g, "");
    if (digits.length < 7) return null;

    // Extract 10-digit national core for Nigerian numbers (080..., 23480..., +23480...)
    let coreDigits = digits;
    if (coreDigits.startsWith("234") && coreDigits.length >= 13) {
      coreDigits = coreDigits.slice(3, 13);
    } else if (coreDigits.startsWith("0") && coreDigits.length >= 11) {
      coreDigits = coreDigits.slice(1, 11);
    } else if (coreDigits.length > 10) {
      coreDigits = coreDigits.slice(-10);
    }

    const rows = await manager.query(
      `SELECT id, email, first_name, last_name, phone, has_account, password_hash
       FROM customer
       WHERE has_account = true
         AND deleted_at IS NULL
         AND phone IS NOT NULL
         AND (
           REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1
           OR REGEXP_REPLACE(phone, '[^0-9]', '', 'g') LIKE $2
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [digits, `%${coreDigits}`]
    );
    return rows?.[0] || null;
  };

  router.options("/store/customers/password-otp/*", cors(storeCorsOptions));

  router.post(
    "/store/customers/password-otp/request",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      const logger = req.scope.resolve("logger");
      try {
        const rawIdentifier =
          req.body?.identifier ||
          req.body?.email_or_phone ||
          req.body?.email ||
          req.body?.phone ||
          "";
        const channel: "auto" | "email" | "phone" = req.body?.channel || "auto";

        if (!String(rawIdentifier).trim()) {
          return res.status(400).json({
            success: false,
            message: "Please provide your registered email address or phone number.",
          });
        }

        const customer = await findRegisteredCustomerByIdentifier(req, rawIdentifier);
        if (!customer) {
          return res.status(404).json({
            success: false,
            message: "No registered customer account was found with that email or phone number.",
          });
        }

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        const hasPhone = Boolean(customer.phone && String(customer.phone).replace(/\D/g, "").length >= 7);
        const hasEmail = Boolean(customer.email && String(customer.email).includes("@"));

        // Determine primary target and extra email so OtpService dual-dispatches SMS + Email
        let primaryTarget = customer.email;
        let extraEmail: string | undefined = undefined;
        const channelsSent: string[] = [];

        if (channel === "email" && hasEmail) {
          primaryTarget = customer.email;
          channelsSent.push("email");
        } else if (hasPhone) {
          primaryTarget = customer.phone;
          channelsSent.push("sms");
          if (hasEmail) {
            extraEmail = customer.email;
            channelsSent.push("email");
          }
        } else if (hasEmail) {
          primaryTarget = customer.email;
          channelsSent.push("email");
        }

        const result = await otpService.sendOtp(
          customer.id,
          primaryTarget,
          "customer_password_reset",
          extraEmail
        );

        return res.status(200).json({
          success: true,
          message: "Verification code sent to your registered contact channels.",
          masked_email: maskEmailAddress(customer.email),
          masked_phone: maskPhoneNumber(customer.phone),
          channels: channelsSent,
          expires_in_seconds: result?.expiresInSeconds || 600,
        });
      } catch (err: any) {
        logger?.error(`[CustomerPasswordOtp] Request error: ${err?.message}`);
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to send verification code. Please try again.",
        });
      }
    }
  );

  router.post(
    "/store/customers/password-otp/verify",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      try {
        const rawIdentifier =
          req.body?.identifier ||
          req.body?.email_or_phone ||
          req.body?.email ||
          req.body?.phone ||
          "";
        const code = String(req.body?.code || "").trim();

        if (!rawIdentifier || !code) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: "Account identifier and verification code are required.",
          });
        }

        const customer = await findRegisteredCustomerByIdentifier(req, rawIdentifier);
        if (!customer) {
          return res.status(404).json({
            success: false,
            valid: false,
            message: "Customer account not found.",
          });
        }

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        const isValid = await otpService.verifyOtp(
          customer.id,
          "customer_password_reset",
          code,
          {
            markAsUsed: false,
            phoneOrEmail: customer.phone || customer.email,
          }
        );

        if (!isValid) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: "Invalid or expired verification code. Please check the code and try again.",
          });
        }

        return res.status(200).json({
          success: true,
          valid: true,
          message: "Verification code confirmed.",
        });
      } catch (err: any) {
        return res.status(500).json({
          success: false,
          valid: false,
          message: err?.message || "Failed to verify code.",
        });
      }
    }
  );

  router.post(
    "/store/customers/password-otp/reset",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      const logger = req.scope.resolve("logger");
      try {
        const rawIdentifier =
          req.body?.identifier ||
          req.body?.email_or_phone ||
          req.body?.email ||
          req.body?.phone ||
          "";
        const code = String(req.body?.code || "").trim();
        const token = String(req.body?.token || "").trim();
        const password = String(req.body?.password || "");

        if (!password || password.length < 6) {
          return res.status(400).json({
            success: false,
            message: "New password must be at least 6 characters long.",
          });
        }

        let customer = rawIdentifier
          ? await findRegisteredCustomerByIdentifier(req, rawIdentifier)
          : null;

        // If a JWT token was supplied without an identifier, decode customer_id from the token
        if (!customer && token) {
          try {
            const jwt = require("jsonwebtoken");
            const decoded: any = jwt.decode(token);
            if (decoded?.customer_id) {
              const manager = req.scope.resolve("manager");
              const rows = await manager.query(
                `SELECT id, email, first_name, last_name, phone, has_account, password_hash
                 FROM customer
                 WHERE id = $1 AND has_account = true AND deleted_at IS NULL
                 LIMIT 1`,
                [decoded.customer_id]
              );
              customer = rows?.[0] || null;
            }
          } catch (_) {}
        }

        if (!customer) {
          return res.status(404).json({
            success: false,
            message: "No registered customer account found.",
          });
        }

        let authorized = false;

        if (code) {
          const OtpServiceMod = require("../services/otp-service");
          const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
          let otpService: any;
          try {
            otpService = req.scope.resolve("otpService");
          } catch (_) {
            otpService = new OtpServiceClass(req.scope.cradle);
          }

          authorized = await otpService.verifyOtp(
            customer.id,
            "customer_password_reset",
            code,
            {
              markAsUsed: true,
              allowRecentlyUsed: true,
              phoneOrEmail: customer.phone || customer.email,
            }
          );
        } else if (token && customer.password_hash) {
          try {
            const jwt = require("jsonwebtoken");
            const verified: any = jwt.verify(token, customer.password_hash);
            if (verified && verified.customer_id === customer.id) {
              authorized = true;
            }
          } catch (_) {
            authorized = false;
          }
        }

        if (!authorized) {
          return res.status(400).json({
            success: false,
            message: "Invalid or expired verification code or reset link. Please request a new code.",
          });
        }

        const customerService = req.scope.resolve("customerService");
        await customerService.update(customer.id, { password });

        logger?.info(`[CustomerPasswordOtp] Password reset completed for customer ${customer.id} (${customer.email})`);

        return res.status(200).json({
          success: true,
          email: customer.email,
          message: "Your password has been updated successfully. You can now sign in.",
        });
      } catch (err: any) {
        logger?.error(`[CustomerPasswordOtp] Reset error: ${err?.message}`);
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to reset password. Please try again.",
        });
      }
    }
  );

  // ── Customer Sign-Up / Phone Verification OTP Endpoints ───────────────────
  router.options("/store/customers/signup-otp/*", cors(storeCorsOptions));

  router.post(
    "/store/customers/signup-otp/send",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      const logger = req.scope.resolve("logger");
      try {
        const rawPhone = String(req.body?.phone || "").trim();
        const rawEmail = String(req.body?.email || "").trim().toLowerCase();
        const digits = rawPhone.replace(/\D/g, "");

        if (digits.length < 7) {
          return res.status(400).json({
            success: false,
            message: "Please enter a valid phone number.",
          });
        }

        // Check if a registered customer account already uses this phone number
        const existingByPhone = await findRegisteredCustomerByIdentifier(req, rawPhone);
        if (existingByPhone) {
          return res.status(409).json({
            success: false,
            already_registered: true,
            message: "An account with this phone number already exists. Please sign in or use Forgot Password.",
          });
        }

        if (rawEmail && rawEmail.includes("@")) {
          const existingByEmail = await findRegisteredCustomerByIdentifier(req, rawEmail);
          if (existingByEmail) {
            return res.status(409).json({
              success: false,
              already_registered: true,
              message: "An account with this email address already exists. Please sign in or use Forgot Password.",
            });
          }
        }

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        let coreDigits = digits;
        if (coreDigits.startsWith("234") && coreDigits.length >= 13) {
          coreDigits = coreDigits.slice(3, 13);
        } else if (coreDigits.startsWith("0") && coreDigits.length >= 11) {
          coreDigits = coreDigits.slice(1, 11);
        }

        const signupUserId = `cust_signup_${coreDigits}`;
        const extraEmail = rawEmail && rawEmail.includes("@") ? rawEmail : undefined;
        const result = await otpService.sendOtp(
          signupUserId,
          rawPhone,
          "customer_signup",
          extraEmail
        );

        return res.status(200).json({
          success: true,
          message: extraEmail
            ? "6-digit verification code sent via SMS and email."
            : "6-digit verification code sent to your phone.",
          masked_phone: maskPhoneNumber(rawPhone),
          masked_email: maskEmailAddress(extraEmail),
          expires_in_seconds: result?.expiresInSeconds || 600,
        });
      } catch (err: any) {
        logger?.error(`[CustomerSignupOtp] Send error: ${err?.message}`);
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to send verification code. Please try again.",
        });
      }
    }
  );

  router.post(
    "/store/customers/signup-otp/verify",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      try {
        const rawPhone = String(req.body?.phone || "").trim();
        const code = String(req.body?.code || req.body?.otp || "").trim();
        const digits = rawPhone.replace(/\D/g, "");

        if (digits.length < 7 || !code) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: "Phone number and 6-digit verification code are required.",
          });
        }

        let coreDigits = digits;
        if (coreDigits.startsWith("234") && coreDigits.length >= 13) {
          coreDigits = coreDigits.slice(3, 13);
        } else if (coreDigits.startsWith("0") && coreDigits.length >= 11) {
          coreDigits = coreDigits.slice(1, 11);
        }

        const signupUserId = `cust_signup_${coreDigits}`;

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        const isValid = await otpService.verifyOtp(
          signupUserId,
          "customer_signup",
          code,
          {
            markAsUsed: true,
            phoneOrEmail: rawPhone,
          }
        );

        if (!isValid) {
          return res.status(400).json({
            success: false,
            valid: false,
            message: "Invalid or expired verification code. Please check and try again.",
          });
        }

        return res.status(200).json({
          success: true,
          valid: true,
          phone: digits,
          message: "Phone number verified successfully.",
        });
      } catch (err: any) {
        return res.status(500).json({
          success: false,
          valid: false,
          message: err?.message || "Failed to verify code.",
        });
      }
    }
  );

  // Normalize invites payload: Medusa V1 expects { user: email, role: 'member' }
  router.use("/admin/invites", (req, res, next) => {
    if (req.method === "POST" && req.body) {
      if (req.body.email && !req.body.user) {
        req.body.user = req.body.email;
        delete req.body.email;
      }
      if (!req.body.role) {
        req.body.role = "member";
      }
    }
    next();
  });

  // Normalize fulfillments payload: Medusa core expects items: [{ item_id, quantity }]
  router.use(/\/admin\/orders\/[^\/]+\/fulfillments/, (req, res, next) => {
    if (req.method === "POST" && req.body && Array.isArray(req.body.items)) {
      req.body.items = req.body.items.map((it: any) => ({
        item_id: it.item_id || it.line_item_id || it.id,
        quantity: it.quantity ?? 1,
      }));
    }
    next();
  });

  // Strip store_id from /admin/orders query parameters so Medusa core's class-validator does not reject the request
  router.use(/\/admin\/orders/, (req, res, next) => {
    if (req.query && req.query.store_id) {
      (req as any).store_id = req.query.store_id;
      delete req.query.store_id;
    }
    next();
  });

  // ── Health Probes & Dynamic Store Shipping Estimate ───────────────────────
  router.get("/store/ping", cors(storeCorsOptions), (_req, res) => {
    res.status(200).json({ status: "ok", service: "afriomarkets-medusa", timestamp: new Date().toISOString() });
  });

  router.get("/admin/ping", cors(adminCorsOptions), (_req, res) => {
    res.status(200).json({ status: "ok", message: "pong", timestamp: new Date().toISOString() });
  });

  router.options("/store/shipping/estimate", cors(storeCorsOptions));
  router.post(
    "/store/shipping/estimate",
    cors(storeCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      try {
        let fulfillmentSvc: CustomManualFulfillmentService;
        try {
          fulfillmentSvc = req.scope.resolve("customManualFulfillmentService");
        } catch (_) {
          fulfillmentSvc = new CustomManualFulfillmentService(req.scope.cradle, {});
        }

        let cart: any = null;
        if (req.body?.cart_id) {
          try {
            const cartService = req.scope.resolve("cartService");
            cart = await cartService.retrieveWithTotals(req.body.cart_id, {
              relations: [
                "items",
                "items.variant",
                "items.variant.product",
                "shipping_address",
                "region",
              ],
            });
          } catch (_) {
            try {
              const cartService = req.scope.resolve("cartService");
              cart = await cartService.retrieve(req.body.cart_id, {
                relations: [
                  "items",
                  "items.variant",
                  "items.variant.product",
                  "shipping_address",
                  "region",
                ],
              });
            } catch (__) {}
          }
        }

        const estimate = await fulfillmentSvc.estimateShipping({
          cart,
          origin_state: req.body?.origin_state,
          origin_country: req.body?.origin_country,
          origin_city: req.body?.origin_city,
          destination_state: req.body?.destination_state || req.body?.province,
          destination_country: req.body?.destination_country || req.body?.country_code,
          destination_city: req.body?.destination_city || req.body?.city,
          weight_kg: req.body?.weight_kg !== undefined ? Number(req.body.weight_kg) : undefined,
          currency_code: req.body?.currency_code,
          subtotal_minor: req.body?.subtotal_minor !== undefined ? Number(req.body.subtotal_minor) : undefined,
          logistics_org_id: req.body?.logistics_org_id || null,
        });

        return res.status(200).json({ success: true, estimate });
      } catch (err: any) {
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to calculate shipping estimate",
        });
      }
    }
  );

  // ── Portal / Vendor / Admin OTP Password Recovery ─────────────────────────
  router.options("/admin/users/password-reset-otp/*", cors(adminCorsOptions));

  router.post(
    "/admin/users/password-reset-otp/request",
    cors(adminCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      const logger = req.scope.resolve("logger");
      try {
        const rawIdentifier = String(
          req.body?.email || req.body?.identifier || req.body?.phone || ""
        ).trim();
        if (!rawIdentifier) {
          return res.status(400).json({
            success: false,
            message: "Please enter your registered email address or phone number.",
          });
        }

        const manager = req.scope.resolve("manager");
        let user: any = null;
        if (rawIdentifier.includes("@")) {
          const rows = await manager.query(
            `SELECT id, email, first_name, last_name, metadata FROM "user" WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
            [rawIdentifier]
          );
          user = rows?.[0] || null;
        } else {
          const digits = rawIdentifier.replace(/\D/g, "");
          const core = digits.length >= 10 ? digits.slice(-10) : digits;
          const rows = await manager.query(
            `SELECT id, email, first_name, last_name, metadata FROM "user"
             WHERE deleted_at IS NULL
               AND (
                 REGEXP_REPLACE(COALESCE(metadata->>'phone', ''), '[^0-9]', '', 'g') LIKE $1
                 OR LOWER(email) = LOWER($2)
               )
             LIMIT 1`,
            [`%${core}`, rawIdentifier]
          );
          user = rows?.[0] || null;
        }

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "No portal account found for that email or phone number.",
          });
        }

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        const phone = user.metadata?.phone || user.metadata?.whatsapp || "";
        const target = phone || user.email;
        const extraEmail = phone && user.email ? user.email : undefined;

        const result = await otpService.sendOtp(
          user.id,
          target,
          "admin_password_reset",
          extraEmail
        );

        return res.status(200).json({
          success: true,
          message: "A 6-digit password reset code has been sent to your registered contact.",
          masked_email: maskEmailAddress(user.email),
          masked_phone: maskPhoneNumber(phone),
          expires_in_seconds: result?.expiresInSeconds || 600,
        });
      } catch (err: any) {
        logger?.error(`[AdminPasswordResetOtp] Request error: ${err?.message}`);
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to send password reset code.",
        });
      }
    }
  );

  router.post(
    "/admin/users/password-reset-otp/confirm",
    cors(adminCorsOptions),
    bodyParser.json(),
    async (req: any, res: any) => {
      const logger = req.scope.resolve("logger");
      try {
        const rawIdentifier = String(
          req.body?.email || req.body?.identifier || req.body?.phone || ""
        ).trim();
        const code = String(req.body?.code || req.body?.otp || "").trim();
        const password = String(req.body?.password || "");

        if (!rawIdentifier || !code || password.length < 8) {
          return res.status(400).json({
            success: false,
            message: "Account email/phone, 6-digit code, and new password (min 8 chars) are required.",
          });
        }

        const manager = req.scope.resolve("manager");
        let user: any = null;
        if (rawIdentifier.includes("@")) {
          const rows = await manager.query(
            `SELECT id, email, metadata FROM "user" WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
            [rawIdentifier]
          );
          user = rows?.[0] || null;
        } else {
          const digits = rawIdentifier.replace(/\D/g, "");
          const core = digits.length >= 10 ? digits.slice(-10) : digits;
          const rows = await manager.query(
            `SELECT id, email, metadata FROM "user"
             WHERE deleted_at IS NULL
               AND REGEXP_REPLACE(COALESCE(metadata->>'phone', ''), '[^0-9]', '', 'g') LIKE $1
             LIMIT 1`,
            [`%${core}`]
          );
          user = rows?.[0] || null;
        }

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "Account not found.",
          });
        }

        const OtpServiceMod = require("../services/otp-service");
        const OtpServiceClass = OtpServiceMod.OtpService || OtpServiceMod.default;
        let otpService: any;
        try {
          otpService = req.scope.resolve("otpService");
        } catch (_) {
          otpService = new OtpServiceClass(req.scope.cradle);
        }

        const phone = user.metadata?.phone || user.metadata?.whatsapp || "";
        const valid = await otpService.verifyOtp(
          user.id,
          "admin_password_reset",
          code,
          {
            markAsUsed: true,
            allowRecentlyUsed: false,
            phoneOrEmail: phone || user.email,
          }
        );

        if (!valid) {
          return res.status(400).json({
            success: false,
            message: "Invalid or expired verification code.",
          });
        }

        // 1. Update Medusa User password_hash
        const userService = req.scope.resolve("userService");
        await userService.update(user.id, { password });

        // 2. Sync password to Supabase Auth if service role key is configured
        try {
          const sbUrl = process.env.SUPABASE_URL;
          const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (sbUrl && sbServiceKey) {
            const { createClient } = require("@supabase/supabase-js");
            const sbAdmin = createClient(sbUrl, sbServiceKey);
            const { data: listRes } = await sbAdmin.auth.admin.listUsers({ perPage: 1000 });
            const matchedSb = (listRes?.users || []).find(
              (u: any) => u.email?.toLowerCase() === String(user.email).toLowerCase()
            );
            if (matchedSb?.id) {
              await sbAdmin.auth.admin.updateUserById(matchedSb.id, { password });
            }
          }
        } catch (sbErr: any) {
          logger?.warn(`[AdminPasswordResetOtp] Supabase password sync warning: ${sbErr?.message}`);
        }

        return res.status(200).json({
          success: true,
          email: user.email,
          message: "Password reset successful. You can now sign in with your new password.",
        });
      } catch (err: any) {
        logger?.error(`[AdminPasswordResetOtp] Confirm error: ${err?.message}`);
        return res.status(500).json({
          success: false,
          message: err?.message || "Failed to update password.",
        });
      }
    }
  );

  // Add authentication to all admin routes *except* auth, ping, onboarding, otp, email, password reset, and account invite ones
  router.use(
    /\/admin\/((?!auth)(?!ping)(?!invites)(?!vendor\/onboarding)(?!users\/reset-password)(?!users\/password-token)(?!users\/password-reset-otp)(?!otp)(?!email)(?!send-email).*)/,
    authenticateAdminOrSupabase
  );

  // Set up routers for store and admin endpoints
  const storeRouter = Router();
  const adminRouter = Router();

  // Also support root-level /otp, /email, /send-email matching AWS-SNS-OTP-API paths
  router.options("/otp", cors(storeCorsOptions));
  router.options("/email", cors(storeCorsOptions));
  router.options("/send-email", cors(storeCorsOptions));
  router.get("/otp", cors(storeCorsOptions), (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });
  router.post("/otp", cors(storeCorsOptions), bodyParser.json(), (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });
  router.post("/email", cors(storeCorsOptions), bodyParser.json(), (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });
  router.post("/send-email", cors(storeCorsOptions), bodyParser.json(), (req, res, next) => {
    (adminRouter as any).handle(req, res, next);
  });

  // Support both Medusa v1 and v2 logout endpoints
  const handleLogout = (req: any, res: any) => {
    if (req.session) {
      delete req.session.user_id;
      if (typeof req.session.destroy === "function") {
        req.session.destroy(() => {});
      }
    }
    res.clearCookie("connect.sid");
    res.clearCookie("jwt");
    res.status(200).json({ success: true, message: "Logged out successfully" });
  };

  router.delete("/auth/session", handleLogout);
  router.delete("/admin/auth/session", handleLogout);
  adminRouter.delete("/auth/session", handleLogout);
  adminRouter.delete("/session", handleLogout);

  // Attach these routers to the root routes
  router.use("/store", storeRouter);
  router.use("/admin", adminRouter);

  // Attach custom routes to these routers
  attachStoreRoutes(storeRouter);
  attachAdminRoutes(adminRouter);

  return router;
};
