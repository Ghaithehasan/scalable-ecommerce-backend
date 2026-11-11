import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrdersCreatedAtIdIndex1794409460623 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_created_at_id_desc ON orders (created_at DESC, id DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_orders_created_at_id_desc`,
    );
  }
}
