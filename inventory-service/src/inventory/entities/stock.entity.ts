import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row per product the warehouse stocks.
 *
 * `product_id` is TEXT, not an integer, for the same reason the contract uses
 * a string: this service must not inherit the main application's choice of
 * primary key type.
 *
 * `available` and `reserved` are kept as separate counters rather than a
 * single total. A reservation moves units from one column to the other, so at
 * any moment `available` is exactly what a new order may take, with no
 * subtraction needed at read time.
 */
@Entity('stock')
export class StockEntity {
  @PrimaryColumn({ name: 'product_id', type: 'text' })
  productId: string;

  /** Units a new reservation may take. The database forbids it going below 0. */
  @Column({ type: 'int' })
  available: number;

  /** Units held by reservations that have not been released. */
  @Column({ type: 'int', default: 0 })
  reserved: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
