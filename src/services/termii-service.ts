import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import https from "https";

export interface SendTermiiResult {
  success: boolean;
  messageId?: string;
  error?: string;
  balance?: number;
}

@Service()
export class TermiiService extends TransactionBaseService {
  protected readonly logger_: Logger;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
  }

  /**
   * Normalizes phone number to standard Termii format (country code without leading +, e.g. 2348012345678).
   */
  public normalizePhoneNumber(phone: string): string {
    const raw = phone.trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("234")) {
      return digits;
    }
    if (digits.startsWith("0") && digits.length === 11) {
      return "234" + digits.slice(1);
    }
    return digits;
  }

  /**
   * Dispatches an SMS or OTP message using Termii's API.
   * By default uses channel "dnd" which bypasses NCC DND filtering in Nigeria.
   */
  async sendSms(to: string, message: string, customFrom?: string): Promise<SendTermiiResult> {
    const apiKey = process.env.TERMII_API_KEY;
    if (!apiKey) {
      this.logger_.warn("[TermiiService] TERMII_API_KEY is not set in environment.");
      return { success: false, error: "TERMII_API_KEY not configured" };
    }

    const formattedPhone = this.normalizePhoneNumber(to);
    const senderId = customFrom || process.env.TERMII_SENDER_ID || "Termii";
    const channel = process.env.TERMII_CHANNEL || "dnd";

    const payload = JSON.stringify({
      to: formattedPhone,
      from: senderId,
      sms: message,
      type: "plain",
      channel: channel,
      api_key: apiKey,
    });

    return new Promise<SendTermiiResult>((resolve) => {
      const req = https.request(
        {
          hostname: "api.ng.termii.com",
          path: "/api/sms/send",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (
                res.statusCode &&
                res.statusCode >= 200 &&
                res.statusCode < 300 &&
                (data.message_id || data.code === "ok" || (data.message && data.message.toLowerCase().includes("sent")))
              ) {
                this.logger_.info(`[TermiiService] SMS dispatched successfully to ${formattedPhone} (MessageID: ${data.message_id || "sent"})`);
                resolve({
                  success: true,
                  messageId: data.message_id,
                  balance: data.balance,
                });
              } else {
                const errMsg = data.message || `Termii error ${res.statusCode}: ${body.substring(0, 200)}`;
                this.logger_.error(`[TermiiService] SMS delivery failed for ${formattedPhone}: ${errMsg}`);
                resolve({ success: false, error: errMsg });
              }
            } catch (err: any) {
              this.logger_.error(`[TermiiService] Non-JSON response from Termii: ${body.substring(0, 200)}`);
              resolve({ success: false, error: `Invalid response: ${body.substring(0, 100)}` });
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        this.logger_.error(`[TermiiService] Connection timeout dispatching SMS to ${formattedPhone}`);
        resolve({ success: false, error: "Connection timeout to Termii" });
      });

      req.on("error", (err) => {
        this.logger_.error(`[TermiiService] Network error dispatching SMS: ${err.message}`);
        resolve({ success: false, error: err.message });
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Fetches the current account balance from Termii.
   */
  async getBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    const apiKey = process.env.TERMII_API_KEY;
    if (!apiKey) {
      return { success: false, error: "TERMII_API_KEY not configured" };
    }

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "api.ng.termii.com",
          path: `/api/get-balance?api_key=${encodeURIComponent(apiKey)}`,
          method: "GET",
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ success: true, balance: data.balance, currency: data.currency });
              } else {
                resolve({ success: false, error: data.message || "Failed to fetch Termii balance" });
              }
            } catch (err: any) {
              resolve({ success: false, error: err.message });
            }
          });
        }
      );

      req.on("error", (err) => resolve({ success: false, error: err.message }));
      req.end();
    });
  }
}

export default TermiiService;
