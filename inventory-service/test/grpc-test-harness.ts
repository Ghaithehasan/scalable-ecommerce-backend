import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { INestMicroservice } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AllRpcExceptionsFilter } from '../src/common/filters/rpc-exception.filter';
import { createGrpcValidationPipe } from '../src/common/validation/grpc-validation.pipe';
import {
  INVENTORY_V1_PACKAGE_NAME,
  type GetStockResponse,
  type ReleaseStockResponse,
  type ReserveStockResponse,
} from '../src/generated/inventory/v1/inventory';
import {
  resolveInventoryProtoPath,
  resolveProtoDir,
} from '../src/grpc/proto-path';

/**
 * Boots the real microservice on a free port and returns a real gRPC client.
 *
 * The tests deliberately go over the wire instead of calling InventoryService
 * directly: the transport, the generated decorator, the ValidationPipe, the
 * interceptor and the exception filter are all part of the behaviour being
 * verified, and a direct call would exercise none of them.
 *
 * The database is the one the rest of the tooling uses, configured through the
 * usual DB_* environment variables (see test/README note in the phase report).
 * testcontainers is not used: pulling images on this machine takes many
 * minutes, and the compose database is already the documented target.
 */

export interface InventoryTestClient {
  getStock(productIds: string[]): Promise<CallResult<GetStockResponse>>;
  reserveStock(
    reservationId: string,
    items: { productId: string; quantity: number }[],
    deadlineMs?: number,
  ): Promise<CallResult<ReserveStockResponse>>;
  releaseStock(
    reservationId: string,
  ): Promise<CallResult<ReleaseStockResponse>>;
}

export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: grpc.status; details: string };

export interface Harness {
  client: InventoryTestClient;
  dataSource: DataSource;
  close(): Promise<void>;
}

let nextPort = 50200 + Math.floor(Math.random() * 300);

function rawCall<T>(
  client: grpc.Client,
  method: string,
  payload: unknown,
  deadlineMs: number,
): Promise<CallResult<T>> {
  return new Promise((resolve) => {
    (client as unknown as Record<string, Function>)[method](
      payload,
      { deadline: new Date(Date.now() + deadlineMs) },
      (error: grpc.ServiceError | null, value: T) => {
        if (error) {
          resolve({
            ok: false,
            code: error.code ?? grpc.status.UNKNOWN,
            details: error.details ?? '',
          });
        } else {
          resolve({ ok: true, value });
        }
      },
    );
  });
}

export async function startHarness(): Promise<Harness> {
  const port = nextPort++;
  const url = `127.0.0.1:${port}`;
  const protoPath = resolveInventoryProtoPath();
  const protoDir = resolveProtoDir();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      url,
      package: INVENTORY_V1_PACKAGE_NAME,
      protoPath,
      loader: {
        keepCase: false,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir],
      },
    },
    logger: false,
  }) as INestMicroservice;

  app.useGlobalPipes(createGrpcValidationPipe());
  app.useGlobalFilters(new AllRpcExceptionsFilter());
  await app.listen();

  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(protoPath, {
      keepCase: false,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir],
    }),
  ) as unknown as {
    inventory: { v1: { InventoryService: grpc.ServiceClientConstructor } };
  };

  const raw = new pkg.inventory.v1.InventoryService(
    url,
    grpc.credentials.createInsecure(),
  );

  const client: InventoryTestClient = {
    getStock: (productIds) =>
      rawCall<GetStockResponse>(raw, 'GetStock', { productIds }, 10000),
    reserveStock: (reservationId, items, deadlineMs = 15000) =>
      rawCall<ReserveStockResponse>(
        raw,
        'ReserveStock',
        { reservationId, items },
        deadlineMs,
      ),
    releaseStock: (reservationId) =>
      rawCall<ReleaseStockResponse>(
        raw,
        'ReleaseStock',
        { reservationId },
        10000,
      ),
  };

  const dataSource = app.get(DataSource);

  return {
    client,
    dataSource,
    async close(): Promise<void> {
      raw.close();
      await app.close();
    },
  };
}

/** Puts a product at a known level, so each test starts from a clean slate. */
export async function setStock(
  dataSource: DataSource,
  productId: string,
  available: number,
  reserved = 0,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO stock (product_id, available, reserved)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id)
     DO UPDATE SET available = EXCLUDED.available,
                   reserved  = EXCLUDED.reserved,
                   updated_at = now()`,
    [productId, available, reserved],
  );
}

export async function readStock(
  dataSource: DataSource,
  productId: string,
): Promise<{ available: number; reserved: number } | null> {
  const rows = (await dataSource.query(
    'SELECT available, reserved FROM stock WHERE product_id = $1',
    [productId],
  )) as { available: number; reserved: number }[];

  return rows[0] ?? null;
}

export async function deleteProducts(
  dataSource: DataSource,
  productIds: string[],
): Promise<void> {
  await dataSource.query('DELETE FROM stock WHERE product_id = ANY($1)', [
    productIds,
  ]);
}
