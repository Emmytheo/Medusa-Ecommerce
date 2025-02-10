import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableForeignKey,
} from "typeorm";

export class AddWalletAccountIdToWalletAccountTransaction1731699767962
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if `walletAccountId` column exists by querying the information schema
    const columnCheck = await queryRunner.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'wallet_account_transaction' 
          AND column_name = 'walletAccountId'
        `);

    // If `walletAccountId` column exists, drop it
    if (columnCheck.length > 0) {
      await queryRunner.dropColumn(
        "wallet_account_transaction",
        "walletAccountId"
      );
    }

    // Drop foreign key constraint if exists (to clean up the old reference)
    try {
      await queryRunner.dropForeignKey(
        "wallet_account_transaction",
        "wallet_account_transaction_wallet_account_id_fk" // Adjust name if needed
      );
    } catch (error) {
      console.log("No foreign key to drop.");
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // In case of rollback, re-add the `walletAccountId` column and foreign key if needed
    await queryRunner.addColumn(
      "wallet_account_transaction",
      new TableColumn({
        name: "walletAccountId",
        type: "uuid",
        isNullable: false,
      })
    );

    await queryRunner.createForeignKey(
      "wallet_account_transaction",
      new TableForeignKey({
        columnNames: ["walletAccountId"],
        referencedColumnNames: ["id"],
        referencedTableName: "wallet_account",
        onDelete: "CASCADE",
      })
    );
  }
}
