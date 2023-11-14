import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrderStoreId1698103755405 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "store_id" text`);
        await queryRunner.query(`ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "order_parent_id" text`);
        await queryRunner.query(`ALTER TABLE "order" ADD CONSTRAINT "FK_8a96dde86e3cad9d2fcc6cb171f87" FOREIGN KEY ("order_parent_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`CREATE INDEX "OrderStoreId" ON "order" ("store_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order" DROP CONSTRAINT "FK_8a96dde86e3cad9d2fcc6cb171f87"`);
        await queryRunner.query(`DROP INDEX "OrderStoreId"`);
        await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "store_id"`);
        await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "order_parent_id"`);
    }
}
