import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class WalletAccountVarcharNumbers1731695615135 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Modify `account_numbers` column type to `varchar[]`
        await queryRunner.changeColumn(
          "wallet_account",
          "account_numbers",
          new TableColumn({
            name: "account_numbers",
            type: "varchar",
            isArray: true, // Define as an array of varchar
            isNullable: false, // Adjust this if nullable is needed
            default: "'{}'", // Ensure an empty array is the default
          })
        );
      }
    
      public async down(queryRunner: QueryRunner): Promise<void> {
        // Revert `account_numbers` column type back to `string[]` or equivalent
        await queryRunner.changeColumn(
          "wallet_account",
          "account_numbers",
          new TableColumn({
            name: "account_numbers",
            type: "text", // Or use the type previously defined in your schema
            isArray: true,
            isNullable: false,
            default: "'{}'",
          })
        );
      }

}
