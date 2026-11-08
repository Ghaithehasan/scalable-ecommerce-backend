import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ReservationItemEntity } from './reservation-item.entity';

export enum ReservationStatus {
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED',
}

/**
 * A reservation is identified by the id the CALLER generated, which is what
 * makes reserve and release idempotent: the same id can be retried safely and
 * a compensating release always knows what it is undoing.
 *
 * A RELEASED row with no items is a tombstone: it records "this id was
 * released before it was ever reserved", so a reserve that arrives late - the
 * caller timed out and compensated - is refused instead of taking stock
 * nobody is waiting for.
 */
@Entity('reservations')
export class ReservationEntity {
  @PrimaryColumn({ type: 'text' })
  id: string;

  // Stored as TEXT with a CHECK constraint rather than a PostgreSQL enum:
  // adding a value later is a plain constraint change, not a type migration.
  @Column({ type: 'text' })
  status: ReservationStatus;

  @OneToMany(() => ReservationItemEntity, (item) => item.reservation, {
    cascade: ['insert'],
  })
  items: ReservationItemEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
