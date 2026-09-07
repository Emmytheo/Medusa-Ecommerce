import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, Index, BeforeInsert } from "typeorm";
import { generateEntityId } from "@medusajs/medusa/dist/utils";

@Entity()
export class VendorBankAccount extends BaseEntity {
  @Index("VendorBankAccountUserId")
  @Column({ type: "character varying" })
  user_id: string;

  @Index("VendorBankAccountStoreId")
  @Column({ type: "character varying" })
  store_id: string;

  @Column({ type: "character varying" })
  bank_name: string;

  @Column({ type: "character varying" })
  bank_code: string;

  @Column({ type: "character varying" })
  account_number: string;

  @Column({ type: "character varying" })
  account_name: string;

  @Column({ type: "character varying", nullable: true })
  recipient_code?: string;

  @Column({ type: "character varying", default: "NGN" })
  currency: string;

  @Column({ type: "boolean", default: false })
  is_verified: boolean;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @BeforeInsert()
  private beforeInsert(): void {
    this.id = generateEntityId(this.id, "vba");
  }
}
