import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddUpdatedAtToWalletAccountTransaction1731699299892
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "wallet_account_transaction",
      new TableColumn({
        name: "updated_at",
        type: "timestamp",
        isNullable: false,
        default: "NOW()", // Automatically set the default value to the current timestamp
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("wallet_account_transaction", "updated_at");
  }
}
