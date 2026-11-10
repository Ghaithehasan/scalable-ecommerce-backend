import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',

        host: configService.getOrThrow<string>('DB_HOST'),
        port: Number(configService.get<string>('DB_PORT') ?? 5432),

        username: configService.getOrThrow<string>('DB_USERNAME'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.getOrThrow<string>('DB_DATABASE'),

        // Load entities automatically from imported modules
        autoLoadEntities: true,

        // Never synchronize the schema automatically in production
        synchronize: false,
        connectTimeoutMS: 5000,
        extra: { statement_timeout: 5000, lock_timeout: 3000 },

        // Use TLS when connecting to Azure PostgreSQL
        ssl:
          configService.get<string>('DB_SSL') === 'true'
            ? { rejectUnauthorized: true }
            : false,
      }),
    }),

    UsersModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
