import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
} from "typeorm";
import { User as MedusaUser } from "@medusajs/medusa";
import { Store } from "./store";
import { Wallet } from "./wallet";

@Entity()
export class User extends MedusaUser {
  @Index("UserStoreId")
  @Column({ nullable: true })
  store_id?: string;

  @ManyToOne(() => Store, (store) => store.members)
  @JoinColumn({ name: "store_id", referencedColumnName: "id" })
  store?: Store;

  // Define wallet_id as an optional foreign key to the Wallet table
  @Column({ type: "uuid", nullable: true })
  wallet_id?: string | null;

  // Set up an optional one-to-one relation with Wallet
  @OneToOne(() => Wallet, (wallet) => wallet.user, {
    cascade: true,
    nullable: true,
  })
  @JoinColumn({ name: "wallet_id" })
  wallet?: Wallet | null;
}
