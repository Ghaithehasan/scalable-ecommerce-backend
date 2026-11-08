import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The inventory schema, written as explicit SQL rather than generated from the
 * entities.
 *
 * The CHECK constraints are the point of this migration. Application code can
 * be bypassed - by a future bug, a manual UPDATE, or a second writer - but the
 * database cannot. `available >= 0` means no sequence of events can ever leave
 * the warehouse having promised more units than it holds, and a reservation
 * can only ever be in one of two known states.
 */
export class CreateInventorySchema1762500000000 implements MigrationInterface {
  name = 'CreateInventorySchema1762500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "stock" (
        "product_id" text NOT NULL,
        "available"  integer NOT NULL,
        "reserved"   integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stock" PRIMARY KEY ("product_id"),
        CONSTRAINT "CHK_stock_available_non_negative" CHECK ("available" >= 0),
        CONSTRAINT "CHK_stock_reserved_non_negative" CHECK ("reserved" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "reservations" (
        "id"         text NOT NULL,
        "status"     text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reservations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_reservations_status" CHECK ("status" IN ('RESERVED', 'RELEASED'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "reservation_items" (
        "reservation_id" text NOT NULL,
        "product_id"     text NOT NULL,
        "quantity"       integer NOT NULL,
        CONSTRAINT "PK_reservation_items" PRIMARY KEY ("reservation_id", "product_id"),
        CONSTRAINT "CHK_reservation_items_quantity_positive" CHECK ("quantity" > 0),
        CONSTRAINT "FK_reservation_items_reservation"
          FOREIGN KEY ("reservation_id") REFERENCES "reservations" ("id") ON DELETE CASCADE
      )
    `);

    // Releasing a reservation reads all of its items by reservation_id.
    await queryRunner.query(`
      CREATE INDEX "IDX_reservation_items_reservation_id"
        ON "reservation_items" ("reservation_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_reservation_items_reservation_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "reservation_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stock"`);
  }
}
