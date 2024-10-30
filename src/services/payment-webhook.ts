import { TransactionBaseService } from "@medusajs/medusa";
import { EntityManager } from "typeorm";
import { InjectManager } from "typeorm-typedi-extensions";
import { Logger } from "winston";
import { Service } from "typedi";
import { PaymentWebhook } from "../models/payment-webhook";
import PaymentWebhookRepository from "../repositories/payment-webhook";

@Service()
class PaymentWebhookService extends TransactionBaseService {
  protected readonly logger_: Logger;
  protected readonly webhookRepository_: typeof PaymentWebhookRepository;

  constructor(container) {
    super(container);
    this.logger_ = container.logger;
    this.webhookRepository_ = container.paymentWebhookRepository;
  }

  /**
   * Logs a new webhook event.
   * @param data - Data received from the webhook.
   */
  async logWebhook(data: Record<string, any>): Promise<PaymentWebhook> {
    const webhookRepo = this.activeManager_.withRepository(
      this.webhookRepository_
    );
    const webhook = webhookRepo.create({
      webhook_id: data.id,
      data,
      processed: false,
    });
    return await webhookRepo.save(webhook);
  }

  /**
   * Marks a webhook event as processed.
   * @param webhookId - ID of the webhook event.
   */
  async markAsProcessed(webhookId: string): Promise<void> {
    const webhookRepo = this.activeManager_.withRepository(
      this.webhookRepository_
    );
    const webhook = await webhookRepo.findOne({
      where: { webhook_id: webhookId },
    });
    if (webhook) {
      webhook.processed = true;
      await webhookRepo.save(webhook);
    }
  }
}

export default PaymentWebhookService;
