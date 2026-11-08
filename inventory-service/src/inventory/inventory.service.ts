import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import {
  isUniqueViolation,
  returnedRows,
} from '../common/database/postgres-errors';
import {
  InvalidArgumentError,
  ProductNotFoundError,
  ReservationAlreadyReleasedError,
} from '../common/errors/domain-error';
import type { EnvironmentVariables } from '../config/env.validation';
import type {
  GetStockResponse,
  ReleaseStockResponse,
  ReserveStockResponse,
  Shortage,
} from '../generated/inventory/v1/inventory';
import type {
  GetStockRequestDto,
  ReleaseStockRequestDto,
  ReserveStockRequestDto,
} from './dto/inventory-request.dto';
import { ReservationItemEntity } from './entities/reservation-item.entity';
import {
  ReservationEntity,
  ReservationStatus,
} from './entities/reservation.entity';
import { StockEntity } from './entities/stock.entity';

/**
 * Takes units from `available` and adds them to `reserved`, but only if the
 * units are actually there.
 *
 * The `available >= $2` in the WHERE clause is what prevents overselling, and
 * it does so without `SELECT ... FOR UPDATE`. PostgreSQL takes a row lock when
 * it updates a row; a concurrent transaction touching the same row waits for
 * that lock, and under READ COMMITTED it then RE-EVALUATES the WHERE clause
 * against the newly committed values. So the check and the decrement are one
 * indivisible step: the losing transaction sees the already-reduced number and
 * simply matches no rows. A read-then-write pair could never guarantee that,
 * because another transaction can always commit between the two statements.
 */
const RESERVE_SQL = `
  UPDATE stock
     SET available = available - $2,
         reserved  = reserved  + $2,
         updated_at = now()
   WHERE product_id = $1
     AND available >= $2
  RETURNING product_id, available, reserved
`;

/** The exact inverse, used when a reservation is released. */
const RELEASE_SQL = `
  UPDATE stock
     SET available = available + $2,
         reserved  = reserved  - $2,
         updated_at = now()
   WHERE product_id = $1
  RETURNING product_id
`;

/**
 * Internal rollback signal.
 *
 * "Not enough stock" is a successful call with `reserved = false`, but the
 * partial decrements made before the shortage was found still have to be
 * undone. Throwing is the only way to roll a transaction back, so this error
 * is thrown inside and converted into a normal response outside. It is
 * deliberately not a DomainError: it must never reach the exception filter.
 */
class ShortagesDetected extends Error {
  constructor(readonly shortages: Shortage[]) {
    super('Insufficient stock');
  }
}

/** Byte order, not locale order: every process must sort identically. */
function byProductId<T extends { productId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Batch read. Unknown ids are simply absent from the response. */
  async getStock(request: GetStockRequestDto): Promise<GetStockResponse> {
    if (request.productIds.length === 0) {
      return { items: [] };
    }

    const rows = await this.dataSource.getRepository(StockEntity).find({
      where: { productId: In(request.productIds) },
      order: { productId: 'ASC' },
    });

    return {
      items: rows.map((row) => ({
        productId: row.productId,
        available: row.available,
        reserved: row.reserved,
      })),
    };
  }

  /**
   * Checks and reserves every item, or nothing at all.
   *
   * Stock is never touched outside a transaction, and the whole request
   * succeeds or leaves the database exactly as it was.
   */
  async reserveStock(
    request: ReserveStockRequestDto,
  ): Promise<ReserveStockResponse> {
    this.assertNoDuplicateProducts(request);
    await this.applyArtificialDelay();

    try {
      return await this.dataSource.transaction((manager) =>
        this.reserveInTransaction(manager, request),
      );
    } catch (error) {
      if (error instanceof ShortagesDetected) {
        return { reserved: false, shortages: error.shortages };
      }

      // Two callers raced with the same reservation id. The loser's work was
      // rolled back, so the winner's reservation is the truth: report it.
      if (isUniqueViolation(error)) {
        this.logger.warn(
          `Concurrent duplicate reservation "${request.reservationId}"; returning the stored result`,
        );
        return this.readExistingReservation(request.reservationId);
      }

      throw error;
    }
  }

  private async reserveInTransaction(
    manager: EntityManager,
    request: ReserveStockRequestDto,
  ): Promise<ReserveStockResponse> {
    const reservations = manager.getRepository(ReservationEntity);

    // Idempotency. A retry after a timeout must not reserve a second time.
    const existing = await reservations.findOne({
      where: { id: request.reservationId },
    });

    if (existing) {
      if (existing.status === ReservationStatus.RELEASED) {
        throw new ReservationAlreadyReleasedError(request.reservationId);
      }
      return { reserved: true, shortages: [] };
    }

    // Consistent lock order. Two orders containing the same two products in
    // opposite order would otherwise each hold the row the other needs and
    // deadlock; sorting means every transaction walks the rows the same way,
    // so one simply waits for the other.
    const items = byProductId(request.items);
    const shortages: Shortage[] = [];

    for (const item of items) {
      const updated = returnedRows<{ product_id: string }>(
        await manager.query(RESERVE_SQL, [item.productId, item.quantity]),
      );

      if (updated.length === 1) {
        continue;
      }

      // Nothing matched: either the product is unknown, or there is not
      // enough of it. Those mean very different things to the caller.
      const current = await manager
        .getRepository(StockEntity)
        .findOne({ where: { productId: item.productId } });

      if (!current) {
        throw new ProductNotFoundError(item.productId);
      }

      shortages.push({
        productId: item.productId,
        requested: item.quantity,
        available: current.available,
      });
    }

    // Every shortage is collected before giving up, so the caller learns about
    // all the problems at once instead of one per retry.
    if (shortages.length > 0) {
      throw new ShortagesDetected(shortages);
    }

    await reservations.save(
      reservations.create({
        id: request.reservationId,
        status: ReservationStatus.RESERVED,
        items: items.map((item) =>
          manager.getRepository(ReservationItemEntity).create({
            productId: item.productId,
            quantity: item.quantity,
          }),
        ),
      }),
    );

    return { reserved: true, shortages: [] };
  }

  /**
   * Gives a reservation's units back. Safe to call repeatedly, and safe to
   * call for an id that was never reserved.
   */
  async releaseStock(
    request: ReleaseStockRequestDto,
  ): Promise<ReleaseStockResponse> {
    return this.dataSource.transaction(async (manager) => {
      const reservations = manager.getRepository(ReservationEntity);
      const reservation = await reservations.findOne({
        where: { id: request.reservationId },
        relations: { items: true },
      });

      if (!reservation) {
        // The caller is compensating for a reserve it never saw the answer to.
        // A tombstone records the decision so that if that reserve is still in
        // flight and lands afterwards, it is refused instead of quietly taking
        // stock for an order that was already abandoned.
        await this.writeTombstone(manager, request.reservationId);
        return { released: false };
      }

      if (reservation.status === ReservationStatus.RELEASED) {
        return { released: true };
      }

      for (const item of byProductId(reservation.items)) {
        await manager.query(RELEASE_SQL, [item.productId, item.quantity]);
      }

      await reservations.update(
        { id: request.reservationId },
        { status: ReservationStatus.RELEASED },
      );

      return { released: true };
    });
  }

  private async writeTombstone(
    manager: EntityManager,
    reservationId: string,
  ): Promise<void> {
    try {
      await manager.getRepository(ReservationEntity).insert({
        id: reservationId,
        status: ReservationStatus.RELEASED,
      });
    } catch (error) {
      // Another release for the same id won the race; its tombstone will do.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  /** Reads back the reservation a concurrent caller committed first. */
  private async readExistingReservation(
    reservationId: string,
  ): Promise<ReserveStockResponse> {
    const reservation = await this.dataSource
      .getRepository(ReservationEntity)
      .findOne({ where: { id: reservationId } });

    if (reservation?.status === ReservationStatus.RELEASED) {
      throw new ReservationAlreadyReleasedError(reservationId);
    }

    return { reserved: Boolean(reservation), shortages: [] };
  }

  private assertNoDuplicateProducts(request: ReserveStockRequestDto): void {
    const seen = new Set<string>();

    for (const item of request.items) {
      if (seen.has(item.productId)) {
        throw new InvalidArgumentError(
          `Product "${item.productId}" appears more than once; combine it into a single item`,
        );
      }
      seen.add(item.productId);
    }
  }

  /**
   * Demonstration hook. Applied before the transaction opens so the delay
   * never holds a row lock: the point is to show a client deadline expiring,
   * not to block the warehouse.
   */
  private async applyArtificialDelay(): Promise<void> {
    const delayMs = this.config.get('INVENTORY_ARTIFICIAL_DELAY_MS', {
      infer: true,
    });

    if (delayMs > 0) {
      this.logger.warn(`Artificial delay of ${delayMs}ms is active`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
