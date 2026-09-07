import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateOtpVerification1751000000000 implements MigrationInterface {
  name = "CreateOtpVerification1751000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
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
          {
            name: "deleted_at",
            type: "timestamp with time zone",
            isNullable: true,
          },
        ],
      }),
      true
    );

    await queryRunner.createIndex(
      "otp_verification",
      new TableIndex({
        name: "OtpVerificationUserId",
        columnNames: ["user_id"],
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex("otp_verification", "OtpVerificationUserId");
    await queryRunner.dropTable("otp_verification");
  }
}
