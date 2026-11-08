import 'reflect-metadata';

import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule } from './app.module';
import { AllRpcExceptionsFilter } from './common/filters/rpc-exception.filter';
import { RpcLoggingInterceptor } from './common/interceptors/logging.interceptor';
import { createGrpcValidationPipe } from './common/validation/grpc-validation.pipe';
import { validateEnv } from './config/env.validation';
import {
  healthImplementation,
  registerGrpcServerExtras,
} from './grpc/grpc-server-extras';
import { resolveInventoryProtoPath, resolveProtoDir } from './grpc/proto-path';
import { INVENTORY_V1_PACKAGE_NAME } from './generated/inventory/v1/inventory';

const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
  'fatal',
];

function parseLogLevels(raw: string): LogLevel[] {
  const levels = raw
    .split(',')
    .map((level) => level.trim().toLowerCase())
    .filter((level): level is LogLevel =>
      (VALID_LOG_LEVELS as readonly string[]).includes(level),
    );

  return levels.length > 0 ? levels : ['error', 'warn', 'log'];
}

async function bootstrap(): Promise<void> {
  // The transport options are needed before the Nest container exists, so the
  // environment is validated here as well as inside ConfigModule. Validating
  // twice is cheap; booting with an unvalidated port is not.
  const env = validateEnv(process.env);
  const protoDir = resolveProtoDir();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        url: `${env.GRPC_HOST}:${env.GRPC_PORT}`,
        package: INVENTORY_V1_PACKAGE_NAME,
        protoPath: resolveInventoryProtoPath(),
        loader: {
          // camelCase on the wire objects, matching the generated interfaces.
          keepCase: false,
          // Zero values are present rather than undefined, so an empty list
          // arrives as [] and `reserved: false` is never dropped.
          defaults: true,
          oneofs: true,
          includeDirs: [protoDir],
        },
        // Lets in-flight calls finish before the server closes.
        gracefulShutdown: true,
        // Nest declares this hook as (pkg: any, server: any); the helper
        // narrows both ends itself.
        onLoadPackageDefinition: (pkg, server) =>
          registerGrpcServerExtras(pkg, server),
      },
      // Nest 12: createMicroservice takes TWO arguments. Application options
      // such as the logger merge into this same object (verified in phase 1).
      logger: parseLogLevels(env.LOG_LEVELS),
    },
  );

  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalInterceptors(new RpcLoggingInterceptor());
  app.useGlobalFilters(new AllRpcExceptionsFilter());

  // Runs onModuleDestroy / onApplicationShutdown on SIGTERM, so the database
  // pool is drained instead of being cut off.
  app.enableShutdownHooks();

  process.once('SIGTERM', () => {
    healthImplementation.setStatus('', 'NOT_SERVING');
    healthImplementation.setStatus(
      'inventory.v1.InventoryService',
      'NOT_SERVING',
    );
  });

  await app.listen();
}

void bootstrap();
