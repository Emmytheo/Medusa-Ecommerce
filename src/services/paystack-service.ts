import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import https from "https";

export interface PaystackBank {
  name: string;
  slug: string;
  code: string;
  longcode?: string;
  gateway?: string;
  active: boolean;
  is_deleted?: boolean;
  country: string;
  currency: string;
  type: string;
  id: number;
}

export interface PaystackAccountResolveResult {
  account_number: string;
  account_name: string;
  bank_id?: number;
}

export interface PaystackRecipientResult {
  recipient_code: string;
  active: boolean;
  name: string;
  type: string;
  currency: string;
  details?: {
    account_number: string;
    account_name: string;
    bank_code: string;
    bank_name: string;
  };
}

@Service()
export class PaystackService extends TransactionBaseService {
  protected readonly logger_: Logger;
  private readonly secretKey_: string;
  private bankCache_: { banks: PaystackBank[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours cache for bank list

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
    this.secretKey_ = process.env.PS_KEY || "";
  }

  private async requestPaystack<T = any>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, any>
  ): Promise<{ status: boolean; message: string; data: T }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const options: https.RequestOptions = {
        hostname: "api.paystack.co",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey_}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = "";
        res.on("data", (chunk) => {
          responseData += chunk;
        });

        res.on("end", () => {
          try {
            const parsed = JSON.parse(responseData);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.status) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.message || `Paystack error status: ${res.statusCode}`));
            }
          } catch (e: any) {
            reject(new Error(`Failed to parse Paystack response: ${e.message}`));
          }
        });
      });

      req.on("error", (e) => {
        reject(e);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * Fetches list of supported commercial banks from Paystack.
   */
  async listBanks(country: string = "nigeria"): Promise<PaystackBank[]> {
    const now = Date.now();
    if (this.bankCache_ && now - this.bankCache_.timestamp < this.CACHE_TTL_MS) {
      return this.bankCache_.banks;
    }

    try {
      const res = await this.requestPaystack<PaystackBank[]>(`/bank?country=${encodeURIComponent(country)}&use_cursor=false&perPage=100`);
      if (res.data && Array.isArray(res.data)) {
        this.bankCache_ = {
          banks: res.data,
          timestamp: now,
        };
        return res.data;
      }
      return [];
    } catch (error: any) {
      this.logger_.error(`[PaystackService] listBanks failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Resolves an account number against a bank code using Paystack's bank lookup API.
   * Returns the verified account holder name.
   */
  async resolveAccountNumber(
    accountNumber: string,
    bankCode: string
  ): Promise<PaystackAccountResolveResult> {
    try {
      const sanitizedNumber = accountNumber.trim().replace(/\D/g, "");
      const sanitizedCode = bankCode.trim();

      const res = await this.requestPaystack<PaystackAccountResolveResult>(
        `/bank/resolve?account_number=${encodeURIComponent(sanitizedNumber)}&bank_code=${encodeURIComponent(sanitizedCode)}`
      );

      return res.data;
    } catch (error: any) {
      this.logger_.error(
        `[PaystackService] resolveAccountNumber failed for acc: ${accountNumber}, bank: ${bankCode} - ${error.message}`
      );
      throw new Error(error.message || "Could not resolve bank account details. Please check the account number and bank.");
    }
  }

  /**
   * Creates a Paystack transfer recipient for automated vendor payouts.
   */
  async createTransferRecipient(
    accountName: string,
    accountNumber: string,
    bankCode: string,
    currency: string = "NGN"
  ): Promise<PaystackRecipientResult> {
    try {
      const res = await this.requestPaystack<PaystackRecipientResult>("/transferrecipient", "POST", {
        type: "nuban",
        name: accountName,
        account_number: accountNumber.trim().replace(/\D/g, ""),
        bank_code: bankCode.trim(),
        currency: currency.toUpperCase(),
      });

      return res.data;
    } catch (error: any) {
      this.logger_.error(`[PaystackService] createTransferRecipient failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Initiates a payout transfer to a vendor recipient.
   */
  async initiateTransfer(
    amountMajor: number,
    recipientCode: string,
    reference: string,
    reason: string = "Vendor Payout"
  ): Promise<any> {
    try {
      // Convert to minor unit (kobo/cents)
      const amountMinor = Math.round(amountMajor * 100);

      const res = await this.requestPaystack("/transfer", "POST", {
        source: "balance",
        amount: amountMinor,
        recipient: recipientCode,
        reason,
        reference,
      });

      return res.data;
    } catch (error: any) {
      this.logger_.error(`[PaystackService] initiateTransfer failed: ${error.message}`);
      throw error;
    }
  }
}

export default PaystackService;
