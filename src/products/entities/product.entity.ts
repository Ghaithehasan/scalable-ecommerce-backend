import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericColumnTransformer } from '../../common/transformers/numeric-column.transformer';
import { CategoryEntity } from './category.entity';
import { ProductImageEntity } from './product-image.entity';

/**
 * A product deliberately carries no stock quantity: inventory is owned by the
 * separate warehouse service introduced in requirement 2, and duplicating it
 * here would create two conflicting sources of truth.
 */
@Entity('products')
@Index(['categoryId', 'createdAt'])
export class ProductEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericColumnTransformer,
  })
  price!: number;

  @Column({ name: 'category_id', type: 'int' })
  categoryId!: number;

  // RESTRICT keeps a category that still classifies products from being
  // deleted, so no product is ever left pointing at a missing category.
  @ManyToOne(() => CategoryEntity, (category) => category.products, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'category_id' })
  category!: CategoryEntity;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @OneToMany(() => ProductImageEntity, (image) => image.product, {
    cascade: ['insert', 'update'],
  })
  images!: ProductImageEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
