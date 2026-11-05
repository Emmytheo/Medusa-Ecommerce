import { Router } from "express";
import { MedusaContainer, MedusaRequest, MedusaResponse } from "@medusajs/medusa";
import AwsSnsService from "../../../services/aws-sns-service";
import TermiiService from "../../../services/termii-service";
import EmailService from "../../../services/email-service";
import DeviceGatewayService from "../../../services/device-gateway-service";

export default function attachNotificationRoutes(router: Router) {
  const getAwsSnsService = (container: MedusaContainer): AwsSnsService => {
    try {
      return container.resolve("awsSnsService");
    } catch (_) {
      return new AwsSnsService(container);
    }
  };

  const getTermiiService = (container: MedusaContainer): TermiiService => {
    try {
      return container.resolve("termiiService");
    } catch (_) {
      return new TermiiService(container);
    }
  };

  const getEmailService = (container: MedusaContainer): EmailService => {
    try {
      return container.resolve("emailService");
    } catch (_) {
      return new EmailService(container);
    }
  };

  const getDeviceGatewayService = (container: MedusaContainer): DeviceGatewayService => {
    try {
      return container.resolve("deviceGatewayService");
    } catch (_) {
      return new DeviceGatewayService(container);
    }
  };

  const handleOtpRequest = async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const awsSnsService = getAwsSnsService(container);
    const termiiService = getTermiiService(container);
    const deviceGatewayService = getDeviceGatewayService(container);

    const rawNumber = (
      req.query.number ||
      req.query.phone ||
      req.body?.number ||
      req.body?.phone ||
      ""
    ).toString().trim();
    const subject = (req.query.subject || req.body?.subject || "Afriomarkets").toString().trim();
    const otp = (
      req.query.otp ||
      req.body?.otp ||
      Math.floor(1000 + Math.random() * 9000).toString()
    ).toString().trim();

    if (!rawNumber) {
      res.status(400).json({ Error: "Missing phone number parameter 'number' or 'phone'." });
      return;
    }

    const requestedProvider = (
      req.query.provider ||
      req.body?.provider ||
      process.env.SMS_PROVIDER ||
      "auto"
    ).toString().toLowerCase().trim();

    const message = (
      req.query.message ||
      req.body?.message ||
      (process.env.OTP_SMS_TEMPLATE
        ? process.env.OTP_SMS_TEMPLATE.replace("{code}", otp)
        : `Your Afriomarkets code is ${otp}. Valid for 10 minutes. [Official OTP Fallback]. Do not share this code.`)
    ).toString();
    try {
      const isNigerian =
        rawNumber.startsWith("+234") ||
        rawNumber.startsWith("234") ||
        /^0[789][01]\d{8}$/.test(rawNumber.replace(/\D/g, ""));

      // 1. Explicit Gateway only
      if (
        requestedProvider === "phone_gateway" ||
        requestedProvider === "gateway" ||
        requestedProvider === "phone" ||
        requestedProvider === "device"
      ) {
        const result = await deviceGatewayService.sendSms(rawNumber, message, {
          purpose: "otp",
          subject,
        });
        if (result.success) {
          res.status(200).json({
            Provider: "phone_gateway",
            MessageID: result.messageId,
            CommandID: result.commandId,
            OTP: otp,
          });
          return;
        }
        // Fallback to SNS
        const fallbackRes = await awsSnsService.sendSms(rawNumber, message, subject);
        if (fallbackRes.success) {
          res.status(200).json({ Provider: "sns_fallback", MessageID: fallbackRes.messageId, OTP: otp });
          return;
        }
        res.status(500).json({ Error: result.error || fallbackRes.error });
        return;
      }

      // 2. Explicit Termii (always also dispatch to gateway device)
      if (requestedProvider === "termii") {
        const [termiiRes, gwRes] = await Promise.allSettled([
          termiiService.sendSms(rawNumber, message, subject),
          deviceGatewayService.sendSms(rawNumber, message, { purpose: "otp", subject }),
        ]);
        const termiiVal = termiiRes.status === "fulfilled" ? termiiRes.value : null;
        const gwVal = gwRes.status === "fulfilled" ? gwRes.value : null;

        if (termiiVal?.success || gwVal?.success) {
          res.status(200).json({
            Provider: "termii+gateway",
            MessageID: termiiVal?.messageId || gwVal?.commandId,
            TermiiMessageID: termiiVal?.messageId,
            GatewayCommandID: gwVal?.commandId,
            OTP: otp,
          });
          return;
        }
        // Fallback to SNS
        const fallbackSns = await awsSnsService.sendSms(rawNumber, message, subject);
        if (fallbackSns.success) {
          res.status(200).json({ Provider: "sns_fallback", MessageID: fallbackSns.messageId, OTP: otp });
          return;
        }
        res.status(500).json({ Error: "All SMS transports failed." });
        return;
      }

      // 3. Default "auto" / "sns":
      // As long as an SMS is sent through AWS SNS (or Termii), ALSO send to gateway device concurrently!
      const [snsRes, gwRes] = await Promise.allSettled([
        awsSnsService.sendSms(rawNumber, message, subject),
        deviceGatewayService.sendSms(rawNumber, message, { purpose: "otp", subject }),
      ]);
      const snsVal = snsRes.status === "fulfilled" ? snsRes.value : null;
      const gwVal = gwRes.status === "fulfilled" ? gwRes.value : null;

      if (snsVal?.success || gwVal?.success) {
        res.status(200).json({
          Provider: "sns+gateway",
          MessageID: snsVal?.messageId || gwVal?.commandId,
          SnsMessageID: snsVal?.messageId,
          GatewayCommandID: gwVal?.commandId,
          Results: {
            sns: snsVal?.success ? "OK" : snsVal?.error || "failed",
            gateway: gwVal?.success ? "OK" : gwVal?.error || "failed",
          },
          OTP: otp,
        });
        return;
      }

      // Fallback to Termii if both SNS and Gateway failed
      if (process.env.TERMII_API_KEY) {
        const termiiFallback = await termiiService.sendSms(rawNumber, message, subject);
        if (termiiFallback.success) {
          res.status(200).json({
            Provider: "termii_fallback",
            MessageID: termiiFallback.messageId,
            OTP: otp,
          });
          return;
        }
      }

      res.status(500).json({
        Error: `All SMS dispatch methods failed (SNS: ${snsVal?.error} | Gateway: ${gwVal?.error})`,
      });
    } catch (err: any) {
      res.status(500).json({ Error: err.message });
    }
  };

  /**
   * GET /otp (or /admin/otp)
   * Direct drop-in replacement for AWS-SNS-OTP-API /otp endpoint.
   */
  router.get("/otp", handleOtpRequest);

  /**
   * POST /otp (or /admin/otp)
   */
  router.post("/otp", handleOtpRequest);

  /**
   * POST /admin/gateway/sms
   * Explicitly dispatches an SMS command through the Android Cellular Edge Gateway.
   */
  router.post("/gateway/sms", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const deviceGatewayService = getDeviceGatewayService(container);

    const to = (req.body?.to || req.body?.phone || req.body?.phone_number || "").toString().trim();
    const message = (req.body?.message || "").toString();
    const simSlot = typeof req.body?.sim_slot === "number" ? req.body.sim_slot : 0;
    const deviceId = (req.body?.device_id || "all").toString().trim();
    const metadata = req.body?.metadata || {};
    const waitForAckMs = typeof req.body?.wait_for_ack_ms === "number" ? req.body.wait_for_ack_ms : 0;

    if (!to || !message) {
      res.status(400).json({ error: "Missing required fields 'to' (phone number) and 'message'." });
      return;
    }

    const result = await deviceGatewayService.sendSms(
      to,
      message,
      metadata,
      simSlot,
      deviceId,
      waitForAckMs
    );

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
  });

  /**
   * GET /admin/gateway/status/:command_id
   * Queries status of an edge device command.
   */
  router.get("/gateway/status/:command_id", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const deviceGatewayService = getDeviceGatewayService(container);

    const log = await deviceGatewayService.getCommandStatus(req.params.command_id);
    if (!log) {
      res.status(404).json({ error: "Command not found" });
      return;
    }

    res.status(200).json(log);
  });

  /**
   * GET /admin/gateway/logs
   * Retrieves recent gateway command logs.
   */
  router.get("/gateway/logs", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const deviceGatewayService = getDeviceGatewayService(container);

    const limit = parseInt(req.query.limit as string, 10) || 50;
    const logs = await deviceGatewayService.getRecentLogs(limit);
    res.status(200).json({ count: logs.length, logs });
  });

  /**
   * GET /admin/gateway/devices
   * Lists known active edge devices.
   */
  router.get("/gateway/devices", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const deviceGatewayService = getDeviceGatewayService(container);

    const devices = deviceGatewayService.getActiveDevices();
    res.status(200).json({ devices });
  });

  /**
   * GET /termii/balance
   * Check Termii account balance
   */
  router.get("/termii/balance", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const termiiService = getTermiiService(container);
    const balanceInfo = await termiiService.getBalance();
    res.json(balanceInfo);
  });

  /**
   * POST /email (or /admin/email)
   * Drop-in replacement for AWS-SNS-OTP-API /email endpoint.
   */
  router.post("/email", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const emailService = getEmailService(container);

    const { to, subject, text, html } = req.body;
    if (!to || !subject) {
      res.status(400).json({ message: "Missing 'to' or 'subject' in request body." });
      return;
    }

    try {
      const result = await emailService.sendEmail({ to, subject, text, html });
      if (result.success) {
        res.status(200).send("Email sent: " + result.messageId);
      } else {
        res.status(500).send("Email error: " + result.error);
      }
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  /**
   * POST /send-email (or /admin/send-email)
   * Drop-in replacement for AWS-SNS-OTP-API /send-email endpoint.
   */
  router.post("/send-email", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const emailService = getEmailService(container);

    const { type, data } = req.body;
    if (!type || !data) {
      res.status(400).json({ message: "Missing 'type' or 'data' in request body." });
      return;
    }

    try {
      const result = await emailService.sendTemplatedEmail(type, data);
      res.status(200).json({ message: `Email sent successfully`, details: result });
    } catch (err: any) {
      res.status(500).json({ message: "Error sending email: " + err.message });
    }
  });
}
