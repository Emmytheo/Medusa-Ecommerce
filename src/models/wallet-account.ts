import { BaseEntity } from "@medusajs/medusa";
import { Entity, Column, ManyToOne, OneToMany, Index, JoinColumn } from "typeorm";
import { Wallet } from "./wallet";
import { WalletAccountTransaction } from "./wallet-account-transaction";

@Entity()
export class WalletAccount extends BaseEntity {
  @Index()
  @ManyToOne(() => Wallet, (wallet) => wallet.accounts, { nullable: false })
  @JoinColumn({ name: "wallet_id" }) // Explicitly map the foreign key
  wallet: Wallet;

  @Column({ type: "uuid" }) // Matches UUID type of the related Wallet entity
  wallet_id: string;

  @Column({ type: "uuid" }) 
  id: string;

  @Column({ type: "varchar", length: 3 })
  currency: string;

  @Column({ type: "varchar", array: true }) // PostgreSQL's native array type
  account_numbers: string[];

  @Column({ type: "decimal", default: 0, precision: 15, scale: 2 })
  balance: number;

  @OneToMany(
    () => WalletAccountTransaction,
    (transaction) => transaction.walletAccount
  )
  transactions: WalletAccountTransaction[];
}
