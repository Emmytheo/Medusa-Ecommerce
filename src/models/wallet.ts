import { BaseEntity } from "@medusajs/medusa";
import {
  Entity,
  Column,
  OneToMany,
  Index,
  OneToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  PrimaryColumn,
} from "typeorm";
import { WalletAccount } from "./wallet-account";
import { User } from "./user";

@Entity()
export class Wallet extends BaseEntity {
  @Index()
  @OneToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ type: "character varying", unique: true })
  user_id: string;

  @Column({ type: "uuid" }) 
  id: string;

  @Column({ type: "jsonb", default: {} })
  total_balance: Record<string, number>;

  @OneToMany(() => WalletAccount, (walletAccount) => walletAccount.wallet)
  accounts: WalletAccount[];
}
