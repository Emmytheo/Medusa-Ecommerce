import { BaseEntity } from "@medusajs/medusa"
import { Entity, Column, OneToMany, Index, OneToOne, JoinColumn } from "typeorm"
import { WalletAccount } from "./wallet-account"
import { User } from "./user"

@Entity()
export class Wallet extends BaseEntity {
  @Index()
  @OneToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user: User

  @Column({ unique: true })
  user_id: string

  @Column({ type: "decimal", default: 0, precision: 15, scale: 2 })
  total_balance: number

  @OneToMany(() => WalletAccount, (walletAccount) => walletAccount.wallet)
  accounts: WalletAccount[]
}
