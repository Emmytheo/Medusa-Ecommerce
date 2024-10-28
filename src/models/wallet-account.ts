import { BaseEntity } from "@medusajs/medusa"
import { Entity, Column, ManyToOne, OneToMany, Index } from "typeorm"
import { Wallet } from "./wallet"
import { WalletAccountTransaction } from "./wallet-account-transaction"

@Entity()
export class WalletAccount extends BaseEntity {
  @Index()
  @ManyToOne(() => Wallet, (wallet) => wallet.accounts)
  wallet: Wallet

  @Column({ nullable: false })
  wallet_id: string

  @Column({ type: "varchar", length: 3 })
  currency: string

  @Column("simple-array") // stores array of account numbers as comma-separated values
  account_numbers: string[]

  @Column({ type: "decimal", default: 0, precision: 15, scale: 2 })
  balance: number

  @OneToMany(() => WalletAccountTransaction, (transaction) => transaction.walletAccount)
  transactions: WalletAccountTransaction[]
}
