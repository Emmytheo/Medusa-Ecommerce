import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import nodemailer, { Transporter } from "nodemailer";

export interface SendEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

@Service()
export class EmailService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected transporter_: Transporter | null = null;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const port = parseInt(process.env.SMTP_PORT || "587", 10);

    if (host && user && pass) {
      try {
        this.transporter_ = nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: { user, pass },
        });
      } catch (err: any) {
        this.logger_.warn(`[EmailService] Failed to initialize SMTP transporter: ${err.message}`);
      }
    }
  }

  /**
   * Sends a general email via configured SMTP.
   */
  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.transporter_) {
      this.initTransporter();
    }
    if (!this.transporter_) {
      this.logger_.warn("[EmailService] SMTP credentials not configured (SMTP_HOST / SMTP_USER / SMTP_PASS).");
      return { success: false, error: "SMTP credentials not configured" };
    }

    try {
      const fromAddress = process.env.SMTP_USER || "no-reply@afriomarkets.com";
      const info = await this.transporter_.sendMail({
        from: `"Afriomarket Stores" <${fromAddress}>`,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      this.logger_.info(`[EmailService] Email successfully sent to ${options.to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error: any) {
      this.logger_.error(`[EmailService] Error sending email to ${options.to}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sends an OTP verification email.
   */
  async sendOtpEmail(to: string, code: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const subject = "Afriomarkets Security Verification Code";
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 24px; border: 1px solid #eaeaea; border-radius: 8px;">
        <h2 style="color: #344F16; margin-top: 0;">Afriomarkets Verification</h2>
        <p style="font-size: 15px; color: #555;">Use the verification code below to complete your authentication:</p>
        <div style="background-color: #f4f7f2; padding: 16px; border-radius: 6px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #344F16;">${code}</span>
        </div>
        <p style="font-size: 13px; color: #888;">This code is valid for 10 minutes. If you did not request this code, you can safely ignore this email.</p>
        <p style="font-size: 13px; color: #888; margin-bottom: 0;">Warm regards,<br/>The Afriomarkets Team</p>
      </div>
    `;
    return this.sendEmail({
      to,
      subject,
      text: `Your Afriomarkets verification code is: ${code}. It expires in 10 minutes.`,
      html,
    });
  }

  /**
   * Sends templated emails for order confirmation, invitations, customer signup, and newsletter.
   */
  async sendTemplatedEmail(type: string, data: any): Promise<any> {
    const companyName = process.env.COMPANY_NAME || "Afriomarket Stores";

    switch (type) {
      case "customer_signup": {
        const { first_name, last_name, email, phone } = data;
        const subject = `Welcome to ${companyName}!`;
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; background-color: #fff; border-radius: 8px;">
            <h1 style="color: #333;">Welcome, ${first_name || ""} ${last_name || ""}!</h1>
            <p style="color: #555;">Thank you for signing up with ${companyName}. We're thrilled to have you on board.</p>
            <div style="margin-top: 20px; padding: 15px; background-color: #f1f1f1; border-radius: 6px;">
              <p><strong>Email:</strong> ${email || ""}</p>
              <p><strong>Phone:</strong> ${phone || ""}</p>
            </div>
            <p style="color: #555; margin-top: 20px;">You can now access your dashboard and explore the features of our platform.</p>
            <p style="color: #888;">Warm regards,<br/>The ${companyName} Team</p>
          </div>
        `;
        return this.sendEmail({ to: email, subject, html });
      }

      case "invite": {
        const { email } = data;
        const subject = `You are Invited to ${companyName}!`;
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px;">
            <h2>You've been invited to join ${companyName}</h2>
            <p>You have been invited to register and manage operations on our platform.</p>
            <p>Please click the invitation link received or use your invite code during registration.</p>
          </div>
        `;
        return this.sendEmail({ to: email, subject, html });
      }

      case "order": {
        const { email, id, total } = data;
        const subject = `Order Confirmation - ${id}`;
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px;">
            <h2>Order Confirmation</h2>
            <p>Thank you for your order <strong>${id}</strong>.</p>
            <p>Order Total: <strong>${total ? (parseFloat(total) / 100).toFixed(2) : ""}</strong></p>
          </div>
        `;
        return this.sendEmail({ to: email, subject, html });
      }

      case "newsletter": {
        const { email, title, body } = data;
        return this.sendEmail({
          to: email,
          subject: title || `Update from ${companyName}`,
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px;">${body}</div>`,
        });
      }

      default:
        throw new Error(`Unsupported email template type: ${type}`);
    }
  }
}

export default EmailService;
