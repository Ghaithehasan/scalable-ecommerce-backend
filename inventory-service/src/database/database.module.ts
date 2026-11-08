import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';

import type { EnvironmentVariables } from '../config/env.validation';

/**
 * The inventory database, owned exclusively by this service.
 *
 * `synchronize` is off on purpose. The main application can afford schema
 * synchronisation on boot, but stock rows are money: the schema here changes
 * only through reviewed migrations (added in phase 3), never by inference from
 * the entity classes.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        type: 'postgres' as const,
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        username: config.get('DB_USERNAME', { infer: true }),
        password: config.get('DB_PASSWORD', { infer: true }),
        database: config.get('DB_DATABASE', { infer: true }),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
        extra: {
          // Safety net: a query that somehow holds a row lock for too long is
          // aborted by the database instead of blocking every other reserve.
          statement_timeout: config.get('DB_STATEMENT_TIMEOUT_MS', {
            infer: true,
          }),
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
