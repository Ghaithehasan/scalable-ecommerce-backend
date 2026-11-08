import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { ReservationEntity } from './reservation.entity';

/**
 * What a reservation holds, per product. The composite primary key
 * (reservation_id, product_id) is what makes "the same product twice in one
 * reservation" impossible at the database level, not only in validation.
 */
@Entity('reservation_items')
export class ReservationItemEntity {
  @PrimaryColumn({ name: 'reservation_id', type: 'text' })
  reservationId: string;

  @PrimaryColumn({ name: 'product_id', type: 'text' })
  productId: string;

  @Column({ type: 'int' })
  quantity: number;

  @ManyToOne(() => ReservationEntity, (reservation) => reservation.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'reservation_id' })
  reservation: ReservationEntity;
}
