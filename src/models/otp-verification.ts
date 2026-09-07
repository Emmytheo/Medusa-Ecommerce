import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, Index, BeforeInsert } from "typeorm";
import { generateEntityId } from "@medusajs/medusa/dist/utils";

@Entity()
export class OtpVerification extends BaseEntity {
  @Index("OtpVerificationUserId")
  @Column({ type: "character varying" })
  user_id: string;

  @Column({ type: "character varying" })
  phone_or_email: string;

  @Column({ type: "character varying" })
  code: string;

  @Column({ type: "character varying" })
  purpose: string; // e.g. "bank_account_update", "payout_request", "wallet_pin_update"

  @Column({ type: "timestamp with time zone" })
  expires_at: Date;

  @Column({ type: "boolean", default: false })
  is_used: boolean;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @BeforeInsert()
  private beforeInsert(): void {
    this.id = generateEntityId(this.id, "otp");
  }
}
