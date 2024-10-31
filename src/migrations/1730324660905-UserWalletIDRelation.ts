import {
  MigrationInterface,
  QueryRunner,
  TableForeignKey,
  TableColumn,
} from "typeorm";

export class UserWalletIDRelation1730324660905 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add wallet_id column to User table and create a foreign key to Wallet table
    await queryRunner.addColumn(
      "user",
      new TableColumn({
        name: "wallet_id",
        type: "uuid",
        isNullable: true,
      })
    );

    await queryRunner.createForeignKey(
      "user",
      new TableForeignKey({
        columnNames: ["wallet_id"],
        referencedColumnNames: ["id"],
        referencedTableName: "wallet",
        onDelete: "SET NULL",
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key and wallet_id column from User table
    await queryRunner.dropForeignKey("user", "user_wallet_id_fk");
    await queryRunner.dropColumn("user", "wallet_id");
  }
}
