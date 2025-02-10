import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, ManyToOne, Index, JoinColumn, BeforeInsert } from "typeorm";
import { WalletAccount } from "./wallet-account";
import { v4 as uuidv4 } from "uuid";

/**
 * Generates a unique transaction ID.
 * @returns {string} A unique 36-character transaction ID.
 */
function generateTransactionId(): string {
  return uuidv4(); // UUID generates a 36-character unique identifier
}


@Entity()
export class WalletAccountTransaction extends BaseEntity {
  @Index()
  @ManyToOne(() => WalletAccount, (walletAccount) => walletAccount.transactions, { nullable: false })
  @JoinColumn({ name: "wallet_account_id" }) // Explicitly map the foreign key
  walletAccount: WalletAccount;

  @Column({ type: "uuid" })
  wallet_account_id: string;

  @Column({ type: "uuid" }) 
  id: string;

  @Column({ type: "varchar", length: 36, unique: true })
  transaction_id: string; // ID from payment processor

  @Column({ type: "decimal", precision: 15, scale: 2 })
  amount: number;

  @Column({ type: "varchar", length: 10 })
  type: "credit" | "debit";

  @Column({ type: "varchar", length: 10, default: "pending" })
  status: "pending" | "completed" | "failed";

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any>; // Stores webhook data for reference

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  created_at: Date;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  updated_at: Date;

  // Automatically generate a unique transaction_id before insertion
  @BeforeInsert()
  private assignTransactionId() {
    this.transaction_id = generateTransactionId();
  }
}


