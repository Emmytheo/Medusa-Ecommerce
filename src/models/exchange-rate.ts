// src/models/exchange-rate.ts

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from "typeorm";

@Entity()
export class ExchangeRate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  currency_code: string;

  @Column("float")
  average_rate: number;

  @CreateDateColumn()
  calculated_at: Date;
}
