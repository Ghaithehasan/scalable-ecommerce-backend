import 'reflect-metadata';

import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { validateEnv } from '../config/env.validation';

// The TypeORM CLI runs outside Nest, so ConfigModule has not loaded .env yet.
loadDotenv();

const env = validateEnv(process.env);

/**
 * DataSource used by the TypeORM CLI (migration:run, migration:revert) and by
 * the seed script. The running service builds its own connection through
 * DatabaseModule; this one exists only so the CLI has something to point at.
 */
// TypeORM 1.x refuses a file that exports more than one DataSource, so this
// is a default export only.
const dataSource = new DataSource({
  type: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_DATABASE,
  synchronize: false,
  logging: ['error', 'migration'],
  entities: [join(__dirname, '..', '**', '*.entity.{js,ts}')],
  migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
});

export default dataSource;
