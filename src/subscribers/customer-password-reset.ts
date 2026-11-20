import { type SubscriberConfig, type SubscriberArgs } from "@medusajs/medusa";
import EmailService from "../services/email-service";
import OtpService from "../services/otp-service";

interface CustomerPasswordResetEventData {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  token: string;
}

export default async function customerPasswordResetHandler({
  data,
  container,
}: SubscriberArgs<CustomerPasswordResetEventData>) {
  const logger = container.resolve("logger");

  try {
    const { id, email, first_name, token } = data || ({} as CustomerPasswordResetEventData);
    if (!email) {
      return;
    }

    let emailService: EmailService;
    try {
      emailService = container.resolve("emailService");
    } catch (_) {
      emailService = new EmailService(container);
    }

    const storefrontBaseUrl = (
      process.env.STORE_URL ||
      "https://www.afriomarkets.com"
    ).replace(/\/+$/, "");

    const resetUrl = `${storefrontBaseUrl}/account/login?view=forgot-password&email=${encodeURIComponent(
      email
    )}&token=${encodeURIComponent(token || "")}`;

    const greetingName = first_name ? ` ${first_name}` : "";
    const subject = "Reset Your Afriomarkets Password";
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 540px; margin: auto; padding: 28px; border: 1px solid #e6ece2; border-radius: 12px; background-color: #ffffff;">
        <h2 style="color: #344F16; margin-top: 0; margin-bottom: 12px;">Password Reset Request</h2>
        <p style="font-size: 15px; color: #374151; line-height: 1.6;">
          Hello${greetingName},<br/>
          We received a request to reset the password for your Afriomarkets account associated with <strong>${email}</strong>.
        </p>
        <div style="text-align: center; margin: 26px 0;">
          <a href="${resetUrl}" style="display: inline-block; background-color: #344F16; color: #ffffff; text-decoration: none; font-weight: bold; font-size: 15px; padding: 13px 26px; border-radius: 8px;">
            Reset My Password
          </a>
        </div>
        <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
          Or copy and paste this link into your browser:<br/>
          <a href="${resetUrl}" style="color: #344F16; word-break: break-all;">${resetUrl}</a>
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-top: 20px;">
          This reset link is valid for 15 minutes. If you did not request a password reset, you can safely ignore this email.
        </p>
        <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
          Warm regards,<br/><strong>The Afriomarkets Team</strong>
        </p>
      </div>
    `;

    const text = `Hello${greetingName},\n\nReset your Afriomarkets password using this link (valid for 15 minutes):\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`;

    await emailService.sendEmail({
      to: email,
      subject,
      text,
      html,
    });

    // Also dispatch 6-digit OTP via OtpService if customer has phone or email
    if (id) {
      try {
        let otpService: OtpService;
        try {
          otpService = container.resolve("otpService");
        } catch (_) {
          otpService = new OtpService(container);
        }
        const manager = container.resolve("manager");
        const rows = await manager.query(
          `SELECT phone, email FROM customer WHERE id = $1 LIMIT 1`,
          [id]
        );
        const phone = rows?.[0]?.phone;
        const target = phone || email;
        await otpService.sendOtp(id, target, "customer_password_reset", email);
      } catch (otpErr: any) {
        logger.warn(`[CustomerPasswordResetSubscriber] OTP dispatch notice: ${otpErr?.message}`);
      }
    }

    logger.info(`[CustomerPasswordResetSubscriber] Dispatched password reset instructions to ${email}`);
  } catch (error: any) {
    logger.error(`[CustomerPasswordResetSubscriber] Failed to process customer.password_reset: ${error?.message}`);
  }
}

export const config: SubscriberConfig = {
  event: "customer.password_reset",
  context: {
    subscriberId: "customer-password-reset-handler",
  },
};
