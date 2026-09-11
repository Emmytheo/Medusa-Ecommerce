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
   * Dispatches SMS using AWS End User Messaging SMS (Pinpoint SMS Voice v2) as primary,
   * falling back automatically to legacy AWS SNS Publish if needed.
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
    const activeSenderId = (senderId || process.env.AWS_SNS_SENDER_ID || "AFRIOMARKET").trim();

    // 1. Primary: AWS End User Messaging SMS (Pinpoint SMS Voice v2)
    const voiceRes = await this.sendViaEndUserMessaging(
      accessKey,
      secretKey,
      region,
      formattedPhone,
      message,
      activeSenderId
    );

    if (voiceRes.success) {
      return voiceRes;
    }

    this.logger_.warn(
      `[AwsSnsService] AWS End User Messaging attempt notice (${voiceRes.error}). Attempting fallback to legacy SNS Publish...`
    );

    // 2. Fallback: Legacy AWS SNS Publish
    return await this.sendViaLegacySns(
      accessKey,
      secretKey,
      region,
      formattedPhone,
      message,
      activeSenderId
    );
  }

  /**
   * AWS End User Messaging SMS (Pinpoint SMS Voice v2).
   * Directly targets registered OriginationIdentities (e.g. AFRIOMARKET in af-south-1 for Nigeria)
   * which bypasses carrier filtering.
   */
  private async sendViaEndUserMessaging(
    accessKey: string,
    secretKey: string,
    region: string,
    formattedPhone: string,
    message: string,
    originationIdentity?: string
  ): Promise<SendSmsResult> {
    const host = `sms-voice.${region}.amazonaws.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);

    const payloadObj: any = {
      DestinationPhoneNumber: formattedPhone,
      MessageBody: message,
      MessageType: "TRANSACTIONAL",
    };

    if (originationIdentity) {
      payloadObj.OriginationIdentity = originationIdentity;
    }

    const payload = JSON.stringify(payloadObj);
    const payloadHash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");

    const canonicalHeaders = `content-type:application/x-amz-json-1.0\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:PinpointSMSVoiceV2.SendTextMessage\n`;
    const signedHeaders = "content-type;host;x-amz-date;x-amz-target";

    const canonicalRequest = [
      "POST",
      "/",
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/sms-voice/aws4_request`;
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
    const kService = hmac(kRegion, "sms-voice");
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
            "Content-Type": "application/x-amz-json-1.0",
            Host: host,
            "x-amz-date": amzDate,
            "x-amz-target": "PinpointSMSVoiceV2.SendTextMessage",
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
              try {
                const parsed = JSON.parse(body);
                const messageId = parsed.MessageId;
                this.logger_.info(
                  `[AwsSnsService] SMS dispatched successfully via End User Messaging to ${formattedPhone} (MessageID: ${messageId})`
                );
                resolve({ success: true, messageId });
              } catch {
                resolve({ success: true });
              }
            } else {
              resolve({
                success: false,
                error: `HTTP ${res.statusCode}: ${body.substring(0, 300)}`,
              });
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        resolve({ success: false, error: "Connection timeout sending SMS via End User Messaging" });
      });

      req.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Fallback to legacy AWS SNS Publish API.
   */
  private async sendViaLegacySns(
    accessKey: string,
    secretKey: string,
    region: string,
    formattedPhone: string,
    message: string,
    activeSenderId?: string
  ): Promise<SendSmsResult> {
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
    params.append(`MessageAttributes.entry.${attrIndex}.Name`, "AWS.SNS.SMS.SMSType");
    params.append(`MessageAttributes.entry.${attrIndex}.Value.DataType`, "String");
    params.append(`MessageAttributes.entry.${attrIndex}.Value.StringValue`, "Transactional");
    attrIndex++;

    if (activeSenderId) {
      const validSenderId = activeSenderId.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 11);
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
                `[AwsSnsService] SMS dispatched successfully via legacy SNS to ${formattedPhone} (MessageID: ${messageId})`
              );
              resolve({ success: true, messageId });
            } else {
              this.logger_.error(
                `[AwsSnsService] Legacy AWS SNS error ${res.statusCode}: ${body.substring(0, 300)}`
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
