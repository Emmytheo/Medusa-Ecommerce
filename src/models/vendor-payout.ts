import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, Index, BeforeInsert } from "typeorm";
import { generateEntityId } from "@medusajs/medusa/dist/utils";

export type VendorPayoutStatus = "pending" | "processing" | "completed" | "failed" | "rejected";

@Entity()
export class VendorPayout extends BaseEntity {
  @Index("VendorPayoutUserId")
  @Column({ type: "character varying" })
  user_id: string;

  @Index("VendorPayoutStoreId")
  @Column({ type: "character varying" })
  store_id: string;

  @Column({ type: "character varying" })
  wallet_account_id: string;

  @Column({ type: "decimal", precision: 15, scale: 2 })
  amount: number;

  @Column({ type: "character varying", default: "NGN" })
  currency: string;

  @Column({ type: "character varying", default: "pending" })
  status: VendorPayoutStatus;

  @Column({ type: "character varying", unique: true })
  reference: string;

  @Column({ type: "character varying", nullable: true })
  transfer_code?: string;

  @Column({ type: "jsonb", nullable: true })
  bank_account_snapshot?: Record<string, any>;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @BeforeInsert()
  private beforeInsert(): void {
    this.id = generateEntityId(this.id, "vpout");
  }
}
