import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableColumn,
} from "typeorm";

export class WalletAccountsAndOrderSplits1730295740496
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Wallet Table
    await queryRunner.createTable(
      new Table({
        name: "wallet",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          { name: "user_id", type: "character varying", isUnique: true },
          { name: "total_balance", type: "jsonb", default: "'{}'" },
          {
            name: "created_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
          {
            name: "updated_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
            onUpdate: "CURRENT_TIMESTAMP",
          },
        ],
      })
    );

    // Foreign key for Wallet <-> User
    await queryRunner.createForeignKey(
      "wallet",
      new TableForeignKey({
        columnNames: ["user_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "user",
        onDelete: "CASCADE",
      })
    );

    // WalletAccount Table
    await queryRunner.createTable(
      new Table({
        name: "wallet_account",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          { name: "wallet_id", type: "uuid" },
          { name: "currency", type: "varchar", length: "3" },
          { name: "account_numbers", type: "text", isArray: true },
          {
            name: "balance",
            type: "decimal",
            precision: 15,
            scale: 2,
            default: "0",
          },
          {
            name: "created_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
          {
            name: "updated_at",
            type: "timestamp",
            onUpdate: "CURRENT_TIMESTAMP",
            default: "CURRENT_TIMESTAMP",
          },
        ],
      })
    );

    // Foreign key for WalletAccount <-> Wallet
    await queryRunner.createForeignKey(
      "wallet_account",
      new TableForeignKey({
        columnNames: ["wallet_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "wallet",
        onDelete: "CASCADE",
      })
    );

    // WalletAccountTransaction Table
    await queryRunner.createTable(
      new Table({
        name: "wallet_account_transaction",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          { name: "wallet_account_id", type: "uuid" },
          {
            name: "transaction_id",
            type: "varchar",
            length: "36",
            isUnique: true,
          },
          { name: "amount", type: "decimal", precision: 15, scale: 2 },
          { name: "type", type: "varchar", length: "10" },
          {
            name: "status",
            type: "varchar",
            length: "10",
            default: "'pending'",
          },
          { name: "metadata", type: "jsonb", isNullable: true },
          {
            name: "created_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
        ],
      })
    );

    // Foreign key for WalletAccountTransaction <-> WalletAccount
    await queryRunner.createForeignKey(
      "wallet_account_transaction",
      new TableForeignKey({
        columnNames: ["wallet_account_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "wallet_account",
        onDelete: "CASCADE",
      })
    );

    // PaymentWebhook Table
    await queryRunner.createTable(
      new Table({
        name: "payment_webhook",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          { name: "webhook_id", type: "varchar", length: "36", isUnique: true },
          { name: "data", type: "jsonb" },
          {
            name: "received_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
          { name: "processed", type: "boolean", default: false },
        ],
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop PaymentWebhook Table
    await queryRunner.dropTable("payment_webhook");

    // Drop WalletAccountTransaction Table and its foreign key
    await queryRunner.dropForeignKey(
      "wallet_account_transaction",
      "wallet_account_transaction_wallet_account_id_fk"
    );
    await queryRunner.dropTable("wallet_account_transaction");

    // Drop WalletAccount Table and its foreign key
    await queryRunner.dropForeignKey(
      "wallet_account",
      "wallet_account_wallet_id_fk"
    );
    await queryRunner.dropTable("wallet_account");

    // Drop Wallet Table and its foreign key
    await queryRunner.dropForeignKey("wallet", "wallet_user_id_fk");
    await queryRunner.dropTable("wallet");
  }
}
