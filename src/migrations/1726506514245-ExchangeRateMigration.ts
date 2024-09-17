import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class ExchangeRateMigration1726506514245 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable uuid-ossp extension for UUID generation (PostgreSQL specific)
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Create the exchange_rate table
    await queryRunner.createTable(
      new Table({
        name: "exchange_rate",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          {
            name: "currency_code",
            type: "varchar",
            isNullable: false,
          },
          {
            name: "average_rate",
            type: "float",
            isNullable: false,
          },
          {
            name: "calculated_at",
            type: "timestamp with time zone",
            default: "CURRENT_TIMESTAMP",
            isNullable: false,
          },
        ],
      }),
      true // Indicates that table creation should be logged
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the exchange_rate table
    await queryRunner.dropTable("exchange_rate");
  }
}
