import { TransactionBaseService } from "@medusajs/medusa";
import { Logger } from "winston";
import { Service } from "typedi";
import https from "https";
import crypto from "crypto";

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Service()
export class AwsSnsService extends TransactionBaseService {
  protected readonly logger_: Logger;

  constructor(container: any) {
    super(container);
    this.logger_ = container.logger;
  }

  /**
   * Formats phone number into standard international E.164 format.
   * Handles Nigerian numbers (080... -> +23480..., 23480... -> +23480...) and general international numbers.
   */
  public normalizePhoneNumber(phone: string): string {
    const raw = phone.trim();
    if (raw.startsWith("+")) {
      return "+" + raw.replace(/\D/g, "");
    }
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("234")) {
      return "+" + digits;
    }
    if (digits.startsWith("0") && digits.length === 11) {
      return "+234" + digits.slice(1);
    }
    return "+" + digits;
  }

  /**
   * Publishes an SMS message directly via AWS SNS using AWS Signature Version 4 (SigV4).
   * Fully self-contained with 0 external dependencies (uses native Node.js crypto + https).
   */
  async sendSms(
    phoneNumber: string,
    message: string,
    senderId?: string
  ): Promise<SendSmsResult> {
    const accessKey = (process.env.AWS_ACCESS_KEY_ID || "").trim();
    const secretKey = (process.env.AWS_SECRET_ACCESS_KEY || "").trim();
    const region = (process.env.AWS_REGION || "af-south-1").trim();

    if (!accessKey || !secretKey) {
      this.logger_.warn("[AwsSnsService] AWS credentials missing in environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).");
      return { success: false, error: "AWS credentials missing" };
    }

    const formattedPhone = this.normalizePhoneNumber(phoneNumber);
    const host = `sns.${region}.amazonaws.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);

    const params = new URLSearchParams();
    params.append("Action", "Publish");
    params.append("Version", "2010-03-31");
    params.append("PhoneNumber", formattedPhone);
    params.append("Message", message);

    let attrIndex = 1;
    if (senderId) {
      const validSenderId = senderId.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 11);
      if (validSenderId) {
        params.append(`MessageAttributes.entry.${attrIndex}.Name`, "AWS.SNS.SMS.SenderID");
        params.append(`MessageAttributes.entry.${attrIndex}.Value.DataType`, "String");
        params.append(`MessageAttributes.entry.${attrIndex}.Value.StringValue`, validSenderId);
        attrIndex++;
      }
    }

    const payload = params.toString();
    const payloadHash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");

    const canonicalHeaders = `content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-date";

    const canonicalRequest = [
      "POST",
      "/",
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/sns/aws4_request`;
    const canonicalRequestHash = crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join("\n");

    const hmac = (k: any, s: string): Buffer =>
      (crypto.createHmac as any)("sha256", k).update(s, "utf8").digest();
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "sns");
    const kSigning = hmac(kService, "aws4_request");
    const signature = (hmac(kSigning, stringToSign) as any).toString("hex");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return new Promise<SendSmsResult>((resolve) => {
      const req = https.request(
        {
          hostname: host,
          method: "POST",
          path: "/",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            Host: host,
            "x-amz-date": amzDate,
            Authorization: authHeader,
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const msgIdMatch = body.match(/<MessageId>(.*?)<\/MessageId>/);
              const messageId = msgIdMatch ? msgIdMatch[1] : undefined;
              this.logger_.info(
                `[AwsSnsService] SMS dispatched successfully to ${formattedPhone} (MessageID: ${messageId})`
              );
              resolve({ success: true, messageId });
            } else {
              this.logger_.error(
                `[AwsSnsService] AWS SNS error ${res.statusCode}: ${body.substring(0, 300)}`
              );
              resolve({
                success: false,
                error: `AWS SNS HTTP ${res.statusCode}: ${body.substring(0, 300)}`,
              });
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        this.logger_.error(`[AwsSnsService] Connection timeout dispatching SMS to ${formattedPhone}`);
        resolve({ success: false, error: "Connection timeout sending SMS" });
      });

      req.on("error", (err) => {
        this.logger_.error(`[AwsSnsService] Network error dispatching SMS: ${err.message}`);
        resolve({ success: false, error: err.message });
      });

      req.write(payload);
      req.end();
    });
  }
}

export default AwsSnsService;
