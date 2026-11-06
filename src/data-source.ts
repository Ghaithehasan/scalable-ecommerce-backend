
import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';

import { UserEntity } from './users/entities/user.entity';
import { CategoryEntity } from './products/entities/category.entity';
import { ProductEntity } from './products/entities/product.entity';
import { ProductImageEntity } from './products/entities/product-image.entity';
import { OrderEntity } from './orders/entities/order.entity';
import { OrderItemEntity } from './orders/entities/order-item.entity';

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export default new DataSource({
  type: 'postgres',

  host: requiredEnv('DB_HOST'),
  port: Number(process.env.DB_PORT ?? 5432),
  username: requiredEnv('DB_USERNAME'),
  password: requiredEnv('DB_PASSWORD'),
  database: requiredEnv('DB_DATABASE'),

  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: true }
      : false,

  entities: [
    UserEntity,
    CategoryEntity,
    ProductEntity,
    ProductImageEntity,
    OrderEntity,
    OrderItemEntity,
  ],

  migrations: [__dirname + '/migrations/*{.ts,.js}'],

  synchronize: false,
});
