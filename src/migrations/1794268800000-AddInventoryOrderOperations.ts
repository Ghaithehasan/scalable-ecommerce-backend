import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryOrderOperations1794268800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE orders ADD COLUMN inventory_reservation_id uuid UNIQUE`,
    );
    await queryRunner.query(`CREATE TABLE inventory_order_operations (
      id uuid PRIMARY KEY, user_id integer NOT NULL,
      idempotency_key varchar(100) NOT NULL, request_hash varchar(64) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'COMPLETED', 'CANCEL_PENDING', 'CANCELLED')),
      items jsonb NOT NULL, total_amount numeric(10,2) NOT NULL,
      order_id integer REFERENCES orders(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), last_error_code integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key)
    )`);
    await queryRunner.query(
      `CREATE INDEX inventory_operation_recovery ON inventory_order_operations (status, next_attempt_at, expires_at)`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    const [pending] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM inventory_order_operations WHERE status IN ('PENDING', 'CANCEL_PENDING') OR (status = 'COMPLETED' AND order_id IS NOT NULL)`,
    );
    if (pending.count)
      throw new Error(
        'Resolve pending inventory operations before reverting this migration',
      );
    await queryRunner.query(`DROP TABLE inventory_order_operations`);
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN inventory_reservation_id`,
    );
  }
}
