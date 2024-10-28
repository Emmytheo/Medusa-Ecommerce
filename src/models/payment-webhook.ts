import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, Index } from "typeorm";

@Entity()
export class PaymentWebhook extends BaseEntity {
  @Index()
  @Column({ type: "varchar", length: 36, unique: true })
  webhook_id: string; // unique identifier from the payment processor

  @Column({ type: "jsonb" })
  data: Record<string, any>; // Raw webhook data for reference

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  received_at: Date;

  @Column({ type: "boolean", default: false })
  processed: boolean;
}
