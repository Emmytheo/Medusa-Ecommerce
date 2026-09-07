import { Router } from "express";
import { MedusaContainer, MedusaRequest, MedusaResponse } from "@medusajs/medusa";
import AwsSnsService from "../../../services/aws-sns-service";
import EmailService from "../../../services/email-service";

export default function attachNotificationRoutes(router: Router) {
  const getAwsSnsService = (container: MedusaContainer): AwsSnsService => {
    try {
      return container.resolve("awsSnsService");
    } catch (_) {
      return new AwsSnsService(container);
    }
  };

  const getEmailService = (container: MedusaContainer): EmailService => {
    try {
      return container.resolve("emailService");
    } catch (_) {
      return new EmailService(container);
    }
  };

  /**
   * GET /otp (or /admin/otp)
   * Direct drop-in replacement for AWS-SNS-OTP-API /otp endpoint.
   */
  router.get("/otp", async (req: MedusaRequest, res: MedusaResponse) => {
    const container: MedusaContainer = req.scope;
    const awsSnsService = getAwsSnsService(container);

    const rawNumber = (req.query.number || req.query.phone || "").toString().trim();
    const subject = (req.query.subject || "Afriomarkets").toString().trim();
    const otp = req.query.otp
      ? req.query.otp.toString().trim()
      : Math.floor(1000 + Math.random() * 9000).toString();

    if (!rawNumber) {
      res.status(400).json({ Error: "Missing phone number query parameter 'number'." });
      return;
    }

    const message = `Your verification code is ${otp}`;
    try {
      const result = await awsSnsService.sendSms(rawNumber, message, subject);
      if (result.success) {
        res.status(200).json({ MessageID: result.messageId, OTP: otp });
      } else {
        res.status(500).json({ Error: result.error });
      }
    } catch (err: any) {
      res.status(500).json({ Error: err.message });
    }
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
