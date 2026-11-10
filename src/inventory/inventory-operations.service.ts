import {
  Injectable,
  Logger,
  BadRequestException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { InventoryClient, grpcCode } from './inventory.client';

export interface PricedItem {
  productId: number;
  quantity: number;
  unitPrice: number;
}
export interface OrderOperation {
  id: string;
  user_id: number;
  request_hash: string;
  idempotency_key: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCEL_PENDING' | 'CANCELLED';
  items: PricedItem[];
  total_amount: string;
  order_id: number | null;
}

@Injectable()
export class InventoryOperationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryOperationsService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inFlight?: Promise<void>;
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventory: InventoryClient,
    private readonly config: ConfigService,
  ) {}

  operationKey(value?: string): string {
    if (value === undefined) return `auto:${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
      throw new BadRequestException(
        'Idempotency-Key must contain 1-100 letters, digits, dots, underscores, colons or hyphens',
      );
    return value;
  }
  fingerprint(items: { productId: number; quantity: number }[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          [...items]
            .sort((a, b) => a.productId - b.productId)
            .map(({ productId, quantity }) => ({ productId, quantity })),
        ),
      )
      .digest('hex');
  }
  async find(userId: number, key: string): Promise<OrderOperation | undefined> {
    const [operation] = await this.dataSource.query<OrderOperation[]>(
      'SELECT * FROM inventory_order_operations WHERE user_id = $1 AND idempotency_key = $2',
      [userId, key],
    );
    return operation;
  }
  async begin(
    userId: number,
    key: string,
    hash: string,
    items: PricedItem[],
    total: number,
  ): Promise<{ operation: OrderOperation; created: boolean }> {
    const rows = await this.dataSource.query<OrderOperation[]>(
      `
      INSERT INTO inventory_order_operations
        (id, user_id, idempotency_key, request_hash, items, total_amount, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + $7 * interval '1 millisecond')
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        userId,
        key,
        hash,
        JSON.stringify(items),
        total,
        this.setting('INVENTORY_OPERATION_TIMEOUT_MS', 60000),
      ],
    );
    if (rows.length) return { operation: rows[0], created: true };
    const operation = await this.find(userId, key);
    if (!operation) throw new Error('Order operation disappeared');
    return { operation, created: false };
  }

  async cancelPendingCreation(id: string): Promise<void> {
    // A lost COMMIT response may mean the order actually exists. Only a still-
    // PENDING operation can be compensated; COMPLETED is never blindly released.
    const rows = await this.dataSource.query<{ id: string }[]>(
      `
      WITH changed AS (
        UPDATE inventory_order_operations SET status = 'CANCEL_PENDING', next_attempt_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING' RETURNING id
      ) SELECT id FROM changed`,
      [id],
    );
    if (rows.length) await this.tryCompensate(id);
  }

  async enqueueRelease(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `UPDATE inventory_order_operations
      SET status = 'CANCEL_PENDING', next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('PENDING', 'COMPLETED')`,
      [id],
    );
  }

  async tryCompensate(id: string): Promise<void> {
    await this.process(await this.claim(id));
  }
  async runOnce(): Promise<void> {
    // Recovery after a crash between reserve and local order commit. This CAS
    // competes with the same operation-row lock used while committing an order.
    await this.dataSource.query(`UPDATE inventory_order_operations
      SET status = 'CANCEL_PENDING', next_attempt_at = now(), updated_at = now()
      WHERE status = 'PENDING' AND expires_at <= now()`);
    await this.process(await this.claim());
  }
  private claim(id?: string): Promise<{ id: string }[]> {
    return this.dataSource.query(
      `WITH candidates AS (
      SELECT id FROM inventory_order_operations
      WHERE status = 'CANCEL_PENDING' AND next_attempt_at <= now()
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
    ), claimed AS (
      UPDATE inventory_order_operations op
      SET attempts = attempts + 1, next_attempt_at = now() + $1 * interval '1 millisecond', updated_at = now()
      FROM candidates WHERE op.id = candidates.id RETURNING op.id
    ) SELECT id FROM claimed`,
      [this.setting('INVENTORY_COMPENSATION_RETRY_MS', 5000), id ?? null],
    );
  }
  private async process(jobs: { id: string }[]): Promise<void> {
    await Promise.all(
      jobs.map(async ({ id }) => {
        try {
          await this.inventory.releaseStock(id);
          await this.dataSource.query(
            `UPDATE inventory_order_operations
          SET status = 'CANCELLED', last_error_code = NULL, updated_at = now()
          WHERE id = $1 AND status = 'CANCEL_PENDING'`,
            [id],
          );
          this.logger.log({
            event: 'inventory_compensation_completed',
            reservationId: id,
          });
        } catch (error) {
          // The durable job remains pending even if this process terminates.
          this.logger.warn({
            event: 'inventory_compensation_pending',
            reservationId: id,
            grpcCode: grpcCode(error),
          });
          await this.dataSource.query(
            `UPDATE inventory_order_operations SET last_error_code = $2 WHERE id = $1 AND status = 'CANCEL_PENDING'`,
            [id, grpcCode(error) ?? null],
          );
        }
      }),
    );
  }
  private setting(name: string, fallback: number): number {
    const value = Number(this.config.get<string | number>(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  }
  onModuleInit(): void {
    this.schedule();
  }
  private schedule(): void {
    const interval = Number(
      this.config.get<string | number>('INVENTORY_COMPENSATION_INTERVAL_MS') ??
        5000,
    );
    if (!Number.isSafeInteger(interval) || interval < 0)
      throw new Error(
        'INVENTORY_COMPENSATION_INTERVAL_MS must be a nonnegative integer',
      );
    if (this.stopped || interval === 0) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce()
        .catch(() =>
          this.logger.error({ event: 'inventory_reconciliation_failed' }),
        )
        .finally(() => this.schedule());
    }, interval);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
