import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class RemoveWalletId1731692290553 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if "walletId" column exists in "wallet_account" and remove it
    const table = await queryRunner.getTable("wallet_account");
    const walletIdColumn = table?.findColumnByName("walletId");

    if (walletIdColumn) {
      await queryRunner.dropColumn("wallet_account", "walletId");
    }

    // Ensure "wallet_id" column exists (add if missing)
    const walletIdColumnCorrect = table?.findColumnByName("wallet_id");
    if (!walletIdColumnCorrect) {
      await queryRunner.addColumn(
        "wallet_account",
        new TableColumn({
          name: "wallet_id",
          type: "uuid",
          isNullable: true, // Adjust nullable based on your requirements
        })
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add the incorrect "walletId" column if necessary (rollback logic)
    await queryRunner.addColumn(
      "wallet_account",
      new TableColumn({
        name: "walletId",
        type: "uuid",
        isNullable: true, // Adjust based on previous logic
      })
    );

    // Remove the correct "wallet_id" column if rollback happens
    await queryRunner.dropColumn("wallet_account", "wallet_id");
  }
}
