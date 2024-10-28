import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, ManyToOne, Index } from "typeorm";
import { WalletAccount } from "./wallet-account";

@Entity()
export class WalletAccountTransaction extends BaseEntity {
  @Index()
  @ManyToOne(() => WalletAccount, (walletAccount) => walletAccount.transactions)
  walletAccount: WalletAccount;

  @Column({ nullable: false })
  wallet_account_id: string;

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
}
