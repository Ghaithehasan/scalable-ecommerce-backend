import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericColumnTransformer } from '../../common/transformers/numeric-column.transformer';
import { ProductEntity } from '../../products/entities/product.entity';
import { OrderEntity } from './order.entity';

/**
 * A line of an order. `unitPrice` is a copy of the product price at the moment
 * the order was placed, so later price changes never rewrite order history.
 */
@Entity('order_items')
@Index(['orderId', 'productId'], { unique: true })
export class OrderItemEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'order_id', type: 'int' })
  orderId!: number;

  @ManyToOne(() => OrderEntity, (order) => order.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order!: OrderEntity;

  @Column({ name: 'product_id', type: 'int' })
  productId!: number;

  // RESTRICT protects order history: a product that has been ordered cannot be
  // deleted, it is deactivated instead.
  @ManyToOne(() => ProductEntity, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product!: ProductEntity;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericColumnTransformer,
  })
  unitPrice!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
