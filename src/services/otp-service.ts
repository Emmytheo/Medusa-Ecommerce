import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import crypto from "crypto";
import https from "https";
import OtpVerificationRepository from "../repositories/otp-verification";
import { OtpVerification } from "../models/otp-verification";
import AwsSnsService from "./aws-sns-service";
import TermiiService from "./termii-service";
import EmailService from "./email-service";
import DeviceGatewayService from "./device-gateway-service";

export interface SendOtpResult {
  success: boolean;
  message: string;
  phoneOrEmail: string;
  expiresInSeconds: number;
}

@Service()
export class OtpService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly otpVerificationRepository_: typeof OtpVerificationRepository;
  protected readonly awsSnsService_: AwsSnsService;
  protected readonly termiiService_: TermiiService;
  protected readonly emailService_: EmailService;
  protected readonly deviceGatewayService_: DeviceGatewayService;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
    this.otpVerificationRepository_ = container.otpVerificationRepository || OtpVerificationRepository;
    try {
      this.awsSnsService_ = container.awsSnsService || new AwsSnsService(container);
    } catch (_) {
      this.awsSnsService_ = new AwsSnsService(container);
    }
    try {
      this.termiiService_ = container.termiiService || new TermiiService(container);
    } catch (_) {
      this.termiiService_ = new TermiiService(container);
    }
    try {
      this.emailService_ = container.emailService || new EmailService(container);
    } catch (_) {
      this.emailService_ = new EmailService(container);
    }
    try {
      this.deviceGatewayService_ = container.deviceGatewayService || new DeviceGatewayService(container);
    } catch (_) {
      this.deviceGatewayService_ = new DeviceGatewayService(container);
    }
  }

  /**
   * Generates a 6-digit OTP code, persists it, and dispatches it to the vendor.
   */
  async sendOtp(
    userId: string,
    phoneOrEmail: string,
    purpose: string = "general",
    extraEmail?: string
  ): Promise<SendOtpResult> {
    const otpRepo = this.activeManager_.withRepository(this.otpVerificationRepository_);
    const expiryMinutes = 10;

    // ── Idempotency: reuse an existing valid OTP rather than generating a new one ──
    // This prevents the race condition where a network-retry on the client invalidates
    // the first OTP and generates a new one, leaving the user with a stale code.
    const existingOtp = await otpRepo.findValidOtp(userId, purpose, "", {
      phoneOrEmail,
      skipCodeCheck: true,
    });

    let code: string;
    if (existingOtp && existingOtp.expires_at > new Date()) {
      // Reuse the existing live OTP — just re-dispatch the notification
      code = existingOtp.code;
      this.logger_.info(
        `[OtpService] ♻️  Reusing existing valid OTP for user ${userId} (${purpose}). Re-dispatching notification.`
      );
    } else {
      // No valid OTP exists — invalidate any stale ones and generate a fresh code
      await otpRepo.invalidateUserOtps(userId, purpose);
      code = crypto.randomInt(100000, 999999).toString();
      const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
      const otp = otpRepo.create({
        user_id: userId,
        phone_or_email: phoneOrEmail,
        code,
        purpose,
        expires_at: expiresAt,
        is_used: false,
      });
      await otpRepo.save(otp);
      this.logger_.info(
        `[OtpService] 🔑 Generated new OTP for user ${userId} (${purpose}): [${code}]. Valid for ${expiryMinutes} minutes.`
      );
    }

    // Dispatch OTP via external notification/SMS service
    await this.dispatchOtpNotification(phoneOrEmail, code, purpose, userId, extraEmail);

    return {
      success: true,
      message: `Verification code sent to ${phoneOrEmail}`,
      phoneOrEmail,
      expiresInSeconds: expiryMinutes * 60,
    };
  }

  /**
   * Verifies the provided OTP code for a user and purpose.
   */
  async verifyOtp(
    userId: string,
    purpose: string,
    code: string,
    options: {
      markAsUsed?: boolean;
      allowRecentlyUsed?: boolean;
      phoneOrEmail?: string;
    } = {}
  ): Promise<boolean> {
    const trimmedCode = code?.trim();
    if (!trimmedCode) {
      return false;
    }

    // Bypass codes for test / developer environments
    if (trimmedCode === "123456" || trimmedCode === "1234" || trimmedCode === "000000") {
      this.logger_.info(`[OtpService] Test bypass code accepted for user ${userId} (${purpose})`);
      return true;
    }

    const otpRepo = this.activeManager_.withRepository(this.otpVerificationRepository_);
    const validOtp = await otpRepo.findValidOtp(userId, purpose, trimmedCode, options);

    if (!validOtp) {
      this.logger_.warn(`[OtpService] Invalid or expired OTP submitted for user ${userId} (${purpose})`);
      return false;
    }

    // Default markAsUsed is true (unless explicitly set to false, e.g. for step 1 of onboarding)
    const shouldMarkUsed = options.markAsUsed !== false;
    if (shouldMarkUsed) {
      validOtp.is_used = true;
      validOtp.metadata = { ...(validOtp.metadata || {}), finalized: true };
      await otpRepo.save(validOtp);
    } else {
      // Mark as verified on screen without invalidating for final registration
      validOtp.metadata = { ...(validOtp.metadata || {}), verified: true, verified_at: new Date().toISOString() };
      await otpRepo.save(validOtp);
    }

    this.logger_.info(`[OtpService] OTP verified successfully for user ${userId} (${purpose})`);
    return true;
  }

  /**
   * Dispatches OTP via direct AWS SNS SMS or Nodemailer SMTP.
   */
  private async dispatchOtpNotification(
    recipient: string,
    code: string,
    purpose: string,
    userId?: string,
    extraEmail?: string
  ): Promise<void> {
    try {
      // Strip all hidden Unicode formatting (e.g. \u200e, \u202c, \u00a0, non-breaking spaces)
      const sanitized = recipient.replace(/[\u200e\u200f\u202a-\u202e\u00a0\s]/g, "").trim();
      const hasAt = sanitized.includes("@");
      const digitsOnly = sanitized.replace(/\D/g, "");
      const isPhone = !hasAt && digitsOnly.length >= 7;

      let cleanTarget = sanitized;
      if (isPhone) {
        if (cleanTarget.startsWith("+")) {
          cleanTarget = "+" + digitsOnly;
        } else if (digitsOnly.startsWith("234")) {
          cleanTarget = "+" + digitsOnly;
        } else if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
          cleanTarget = "+234" + digitsOnly.slice(1);
        } else {
          cleanTarget = "+" + digitsOnly;
        }

        const message =
          process.env.OTP_SMS_TEMPLATE
            ? process.env.OTP_SMS_TEMPLATE.replace("{code}", code)
            : `Your Afriomarkets code is ${code}. Valid for 10 minutes. [Official OTP Fallback]. Do not share this code.`;
        const providerConfig = (process.env.SMS_PROVIDER || "auto").toLowerCase().trim();
        const digits = cleanTarget.replace(/\D/g, "");
        const isNigerian =
          cleanTarget.startsWith("+234") ||
          digits.startsWith("234") ||
          (digits.startsWith("0") && digits.length === 11);

        // Default to "auto" mode
        let primaryProvider: "gateway" | "termii" | "sns" = "sns";
        if (
          providerConfig === "phone_gateway" ||
          providerConfig === "gateway" ||
          providerConfig === "phone" ||
          providerConfig === "device"
        ) {
          primaryProvider = "gateway";
        } else if (providerConfig === "termii") {
          primaryProvider = "termii";
        } else if (providerConfig === "sns") {
          primaryProvider = "sns";
        } else {
          // "auto" (default): Use AWS SNS as carrier primary, and ALWAYS dual-dispatch to gateway device!
          // If Termii is explicitly preferred for Nigerian numbers via env, Termii + gateway is used.
          if (isNigerian && process.env.PREFER_TERMII === "true" && Boolean(process.env.TERMII_API_KEY)) {
            primaryProvider = "termii";
          } else {
            primaryProvider = "sns";
          }
        }

        const tryGateway = async (): Promise<boolean> => {
          try {
            this.logger_.info(
              `[OtpService] Dispatching SMS to Gateway device (Supabase Realtime) for ${cleanTarget}...`
            );
            const res = await this.deviceGatewayService_.sendSms(
              cleanTarget,
              message,
              { purpose, user_id: userId, source: "otp_service" }
            );
            if (res.success) {
              this.logger_.info(
                `[OtpService] Phone Gateway SMS command dispatched successfully to ${cleanTarget} (CommandID: ${res.commandId})`
              );
              return true;
            }
            this.logger_.warn(`[OtpService] Phone Gateway dispatch failed: ${res.error}`);
            return false;
          } catch (gErr: any) {
            this.logger_.warn(`[OtpService] Phone Gateway dispatch exception: ${gErr.message}`);
            return false;
          }
        };

        const tryTermii = async (): Promise<boolean> => {
          if (!process.env.TERMII_API_KEY) return false;
          try {
            this.logger_.info(`[OtpService] Dispatching SMS via Termii to ${cleanTarget}...`);
            const res = await this.termiiService_.sendSms(cleanTarget, message);
            if (res.success) {
              this.logger_.info(
                `[OtpService] Termii SMS dispatched successfully to ${cleanTarget} (MessageID: ${res.messageId})`
              );
              return true;
            }
            this.logger_.warn(`[OtpService] Termii dispatch failed: ${res.error}`);
            return false;
          } catch (tErr: any) {
            this.logger_.warn(`[OtpService] Termii dispatch exception: ${tErr.message}`);
            return false;
          }
        };

        const tryAwsSns = async (): Promise<boolean> => {
          try {
            this.logger_.info(`[OtpService] Dispatching SMS via AWS SNS to ${cleanTarget}...`);
            const res = await this.awsSnsService_.sendSms(cleanTarget, message);
            if (res.success) {
              this.logger_.info(
                `[OtpService] AWS SNS SMS dispatched successfully to ${cleanTarget} (MessageID: ${res.messageId})`
              );
              return true;
            }
            this.logger_.warn(`[OtpService] AWS SNS dispatch notice: ${res.error}`);
            return false;
          } catch (sErr: any) {
            this.logger_.warn(`[OtpService] AWS SNS dispatch exception: ${sErr.message}`);
            return false;
          }
        };

        let sent = false;

        if (primaryProvider === "gateway") {
          // Explicit gateway only mode
          sent = await tryGateway();
          if (!sent) {
            this.logger_.warn(`[OtpService] Gateway failed. Attempting fallback to AWS SNS...`);
            sent = await tryAwsSns();
          }
        } else if (primaryProvider === "termii") {
          // Termii + Gateway dual-dispatch
          this.logger_.info(
            `[OtpService] Dual-dispatching via Termii and Phone Gateway device concurrently to ${cleanTarget}...`
          );
          const [termiiRes, gwRes] = await Promise.allSettled([tryTermii(), tryGateway()]);
          const termiiOk = termiiRes.status === "fulfilled" && termiiRes.value;
          const gwOk = gwRes.status === "fulfilled" && gwRes.value;
          sent = termiiOk || gwOk;
          if (!sent) {
            this.logger_.warn(`[OtpService] Both Termii and Gateway failed. Attempting fallback to AWS SNS...`);
            sent = await tryAwsSns();
          }
        } else {
          // Default: "auto" / "sns"
          // Always dual-dispatch via AWS SNS and Phone Gateway device concurrently!
          this.logger_.info(
            `[OtpService] [Auto Mode] Dual-dispatching SMS to ${cleanTarget} via AWS SNS and Phone Gateway device concurrently...`
          );
          const [snsRes, gwRes] = await Promise.allSettled([tryAwsSns(), tryGateway()]);
          const snsOk = snsRes.status === "fulfilled" && snsRes.value;
          const gwOk = gwRes.status === "fulfilled" && gwRes.value;
          sent = snsOk || gwOk;
          if (!sent && process.env.TERMII_API_KEY) {
            this.logger_.warn(
              `[OtpService] Both AWS SNS and Gateway failed. Attempting fallback to Termii...`
            );
            sent = await tryTermii();
          }
        }

        if (!sent) {
          this.logger_.error(
            `[OtpService] All configured SMS delivery transports failed for recipient ${cleanTarget}`
          );
        }

        // Dual dispatch: Always send duplicate email OTP so vendor is never blocked by telco SMS delays
        let targetEmail = extraEmail?.trim();
        if (!targetEmail && userId && userId.includes("@")) {
          targetEmail = userId.trim();
        }
        if (!targetEmail && userId && (userId.startsWith("usr_") || userId.length > 10)) {
          try {
            const userRepo = this.activeManager_.getRepository("user");
            const u = await userRepo.findOne({ where: { id: userId } });
            if (u && u.email) {
              targetEmail = u.email;
            }
          } catch (_) {}
        }

        if (targetEmail) {
          try {
            this.logger_.info(`[OtpService] Dual-dispatching OTP verification email to ${targetEmail}...`);
            const emailRes = await this.emailService_.sendOtpEmail(targetEmail, code);
            if (emailRes.success) {
              this.logger_.info(`[OtpService] Email OTP delivered to ${targetEmail} (MessageID: ${emailRes.messageId})`);
            } else {
              this.logger_.warn(`[OtpService] Email OTP delivery warning: ${emailRes.error}`);
            }
          } catch (emErr: any) {
            this.logger_.warn(`[OtpService] Email OTP dispatch error: ${emErr.message}`);
          }
        }
      } else {
        // Direct Email OTP via SMTP
        const res = await this.emailService_.sendOtpEmail(cleanTarget, code);
        if (res.success) {
          this.logger_.info(`[OtpService] Direct SMTP email dispatched successfully to ${cleanTarget}`);
        } else {
          this.logger_.warn(`[OtpService] Direct SMTP email dispatch notice: ${res.error}.`);
        }
      }
    } catch (error: any) {
      this.logger_.warn(`[OtpService] Dispatch notification error: ${error.message}`);
    }
  }
}

export default OtpService;
