import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import type {
  GetStocksResponse,
  ReleaseStockResponse,
  ReserveStockResponse,
  StockItem,
} from './inventory.types';

type Unary = (
  request: object,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: any) => void,
) => grpc.ClientUnaryCall;

@Injectable()
export class InventoryClient implements OnModuleInit, OnModuleDestroy {
  private client?: grpc.Client & Record<string, Unary>;
  private readonly logger = new Logger(InventoryClient.name);
  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const definition = loader.loadSync(
      resolve(
        __dirname,
        '../..',
        this.config.get<string>('INVENTORY_PROTO_PATH') ??
          'proto/inventory.proto',
      ),
      { keepCase: false, longs: String, arrays: true },
    );
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      inventory: { v1: { InventoryService: grpc.ServiceClientConstructor } };
    };
    this.client = new pkg.inventory.v1.InventoryService(
      this.config.get<string>('INVENTORY_GRPC_URL') ?? '127.0.0.1:50051',
      grpc.credentials.createInsecure(),
    ) as grpc.Client & Record<string, Unary>;
  }
  onModuleDestroy(): void {
    this.client?.close();
  }

  async getStocks(productIds: string[]): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    try {
      const result = await this.call<GetStocksResponse>(
        'GetStocks',
        { productIds },
        'INVENTORY_READ_TIMEOUT_MS',
        1000,
      );
      return new Map(
        result.items.map((item) => [item.productId, item.availableQuantity]),
      );
    } catch (error) {
      if (
        [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED].includes(
          grpcCode(error) ?? -1,
        )
      ) {
        this.logger.warn({
          event: 'inventory_stock_read_unavailable',
          grpcCode: grpcCode(error),
        });
        return new Map();
      }
      throw error;
    }
  }
  reserveStock(
    reservationId: string,
    items: StockItem[],
  ): Promise<ReserveStockResponse> {
    return this.call(
      'ReserveStock',
      { reservationId, items },
      'INVENTORY_RESERVE_TIMEOUT_MS',
      3000,
    );
  }
  releaseStock(reservationId: string): Promise<ReleaseStockResponse> {
    return this.call(
      'ReleaseStock',
      { reservationId },
      'INVENTORY_RELEASE_TIMEOUT_MS',
      3000,
    );
  }
  private call<T>(
    method: string,
    request: object,
    setting: string,
    fallback: number,
  ): Promise<T> {
    const timeout = Number(
      this.config.get<string | number>(setting) ?? fallback,
    );
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new Error(`${setting} must be a positive integer`);
    if (!this.client) throw new Error('Inventory client is not initialized');
    return new Promise((resolve, reject) => {
      // No automatic retry: a deadline does not prove the server rolled back.
      this.client![method](
        request,
        { deadline: Date.now() + timeout },
        (error, response: T) => (error ? reject(error) : resolve(response)),
      );
    });
  }
}

export function grpcCode(error: unknown): number | undefined {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'number'
    ? error.code
    : undefined;
}
