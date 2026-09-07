import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class VendorBankingAndPayouts1735000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Vendor Bank Account Table
    await queryRunner.createTable(
      new Table({
        name: "vendor_bank_account",
        columns: [
          {
            name: "id",
            type: "character varying",
            isPrimary: true,
          },
          {
            name: "user_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "store_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "bank_name",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "bank_code",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "account_number",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "account_name",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "recipient_code",
            type: "character varying",
            isNullable: true,
          },
          {
            name: "currency",
            type: "character varying",
            default: "'NGN'",
          },
          {
            name: "is_verified",
            type: "boolean",
            default: false,
          },
          {
            name: "metadata",
            type: "jsonb",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamp with time zone",
            default: "now()",
          },
          {
            name: "updated_at",
            type: "timestamp with time zone",
            default: "now()",
          },
        ],
      }),
      true
    );

    await queryRunner.createIndex(
      "vendor_bank_account",
      new TableIndex({
        name: "IDX_vendor_bank_account_user_id",
        columnNames: ["user_id"],
      })
    );

    await queryRunner.createIndex(
      "vendor_bank_account",
      new TableIndex({
        name: "IDX_vendor_bank_account_store_id",
        columnNames: ["store_id"],
      })
    );

    // 2. Vendor Payout Table
    await queryRunner.createTable(
      new Table({
        name: "vendor_payout",
        columns: [
          {
            name: "id",
            type: "character varying",
            isPrimary: true,
          },
          {
            name: "user_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "store_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "wallet_account_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "amount",
            type: "numeric",
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: "currency",
            type: "character varying",
            default: "'NGN'",
          },
          {
            name: "status",
            type: "character varying",
            default: "'pending'",
          },
          {
            name: "reference",
            type: "character varying",
            isUnique: true,
            isNullable: false,
          },
          {
            name: "transfer_code",
            type: "character varying",
            isNullable: true,
          },
          {
            name: "bank_account_snapshot",
            type: "jsonb",
            isNullable: true,
          },
          {
            name: "metadata",
            type: "jsonb",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamp with time zone",
            default: "now()",
          },
          {
            name: "updated_at",
            type: "timestamp with time zone",
            default: "now()",
          },
        ],
      }),
      true
    );

    await queryRunner.createIndex(
      "vendor_payout",
      new TableIndex({
        name: "IDX_vendor_payout_user_id",
        columnNames: ["user_id"],
      })
    );

    await queryRunner.createIndex(
      "vendor_payout",
      new TableIndex({
        name: "IDX_vendor_payout_store_id",
        columnNames: ["store_id"],
      })
    );

    // 3. Otp Verification Table
    await queryRunner.createTable(
      new Table({
        name: "otp_verification",
        columns: [
          {
            name: "id",
            type: "character varying",
            isPrimary: true,
          },
          {
            name: "user_id",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "phone_or_email",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "code",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "purpose",
            type: "character varying",
            isNullable: false,
          },
          {
            name: "expires_at",
            type: "timestamp with time zone",
            isNullable: false,
          },
          {
            name: "is_used",
            type: "boolean",
            default: false,
          },
          {
            name: "metadata",
            type: "jsonb",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamp with time zone",
            default: "now()",
          },
          {
            name: "updated_at",
            type: "timestamp with time zone",
            default: "now()",
          },
        ],
      }),
      true
    );

    await queryRunner.createIndex(
      "otp_verification",
      new TableIndex({
        name: "IDX_otp_verification_user_id",
        columnNames: ["user_id"],
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("otp_verification", true);
    await queryRunner.dropTable("vendor_payout", true);
    await queryRunner.dropTable("vendor_bank_account", true);
  }
}
