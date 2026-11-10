import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, type FindOptionsWhere, Repository } from 'typeorm';
import {
  assertOwnership,
  resolveOwnerFilter,
} from '../common/authorization/resource-ownership';
import { isUniqueViolation } from '../common/database/postgres-errors';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { InventoryClient, grpcCode } from '../inventory/inventory.client';
import { inventoryHttpError } from '../inventory/inventory.errors';
import {
  InventoryOperationsService,
  type OrderOperation,
  type PricedItem,
} from '../inventory/inventory-operations.service';
import { ProductsService } from '../products/products.service';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import {
  CreateOrderDto,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
} from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { canTransition, OrderStatus } from './enums/order-status.enum';

const MAX_TOTAL_AMOUNT = 99999999.99;
const ORDER_NUMBER_ATTEMPTS = 5;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly productsService: ProductsService,
    private readonly inventory: InventoryClient,
    private readonly operations: InventoryOperationsService,
  ) {}

  async create(
    dto: CreateOrderDto,
    currentUser: UserResponseDto,
    idempotencyKey?: string,
  ): Promise<OrderEntity> {
    this.validateItems(dto);
    const key = this.operations.operationKey(idempotencyKey);
    const hash = this.operations.fingerprint(dto.items);
    const existing = await this.operations.find(currentUser.id, key);
    if (existing) return this.existingOrder(existing, hash);

    // Catalogue validation and price snapshots happen before the network call,
    // with no database transaction held open across gRPC.
    const products = await this.productsService.findByIds(
      dto.items.map((item) => item.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));
    const items: PricedItem[] = dto.items.map((item) => {
      const product = byId.get(item.productId);
      if (!product)
        throw new NotFoundException(
          `Product with id ${item.productId} not found`,
        );
      if (!product.isActive)
        throw new BadRequestException(
          `Product "${product.name}" is not available for sale`,
        );
      return {
        productId: product.id,
        quantity: item.quantity,
        unitPrice: product.price,
      };
    });
    const total = this.totalOf(items);
    if (total > MAX_TOTAL_AMOUNT)
      throw new BadRequestException(
        'The order total exceeds the maximum amount supported',
      );
    const { operation, created } = await this.operations.begin(
      currentUser.id,
      key,
      hash,
      items,
      total,
    );
    if (!created) return this.existingOrder(operation, hash);

    let orderId: number;
    try {
      await this.inventory.reserveStock(
        operation.id,
        items.map((item) => ({
          productId: String(item.productId),
          quantity: item.quantity,
        })),
      );
      orderId = await this.writeOrder(operation);
    } catch (error) {
      try {
        await this.operations.cancelPendingCreation(operation.id);
      } catch {
        // The already-persisted PENDING operation is recovered after its lease
        // expires. Never release blindly if a lost COMMIT response is possible.
        this.logger.error({
          event: 'inventory_compensation_deferred_to_recovery',
          reservationId: operation.id,
        });
      }
      throw grpcCode(error) !== undefined ? inventoryHttpError(error) : error;
    }
    // A failed response read after COMMIT must never compensate a valid order.
    return this.loadOrFail(orderId);
  }

  private validateItems(dto: CreateOrderDto): void {
    if (
      !Array.isArray(dto?.items) ||
      !dto.items.length ||
      dto.items.length > MAX_ORDER_LINES
    )
      throw new BadRequestException('Invalid order items');
    const seen = new Set<number>();
    for (const item of dto.items) {
      if (
        !item ||
        !Number.isSafeInteger(item.productId) ||
        item.productId <= 0 ||
        item.productId > 2147483647 ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0 ||
        item.quantity > MAX_LINE_QUANTITY
      )
        throw new BadRequestException('Invalid order item');
      if (seen.has(item.productId))
        throw new BadRequestException(
          `Product ${item.productId} appears more than once; combine it into a single item`,
        );
      seen.add(item.productId);
    }
  }

  private async existingOrder(
    operation: OrderOperation,
    hash: string,
  ): Promise<OrderEntity> {
    if (operation.request_hash !== hash)
      throw new ConflictException(
        'Idempotency-Key was already used with different items',
      );
    if (operation.status === 'COMPLETED' && operation.order_id !== null)
      return this.loadOrFail(operation.order_id);
    if (operation.status === 'CANCELLED')
      throw new ConflictException(
        'This operation was cancelled; a new logical order requires a new Idempotency-Key',
      );
    if (operation.status === 'COMPLETED')
      throw new ConflictException(
        'The order created by this operation was deleted',
      );
    throw new ConflictException(
      'This operation is still processing or awaiting compensation; retry with the same Idempotency-Key',
    );
  }

  private async writeOrder(operation: OrderOperation): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          // This row lock fences a stale request against the recovery worker.
          // Either the order and COMPLETED commit together, or cancellation wins.
          const [state] = await manager.query<OrderOperation[]>(
            'SELECT * FROM inventory_order_operations WHERE id = $1 FOR UPDATE',
            [operation.id],
          );
          if (state?.status !== 'PENDING')
            throw new ConflictException(
              'Order operation was cancelled before it could commit',
            );
          const orders = manager.getRepository(OrderEntity);
          const order = orders.create({
            orderNumber: generateOrderNumber(),
            userId: operation.user_id,
            status: OrderStatus.PENDING,
            totalAmount: Number(operation.total_amount),
            inventoryReservationId: operation.id,
            items: operation.items.map((item) =>
              manager.getRepository(OrderItemEntity).create(item),
            ),
          });
          const saved = await orders.save(order);
          await manager.query(
            `UPDATE inventory_order_operations SET status = 'COMPLETED', order_id = $2, updated_at = now() WHERE id = $1`,
            [operation.id, saved.id],
          );
          return saved.id;
        });
      } catch (error) {
        // Only local persistence is retried; never reserve again with a new ID.
        if (isUniqueViolation(error) && attempt < ORDER_NUMBER_ATTEMPTS)
          continue;
        throw error;
      }
    }
  }

  async findAll(
    query: QueryOrdersDto,
    currentUser: UserResponseDto,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    const where: FindOptionsWhere<OrderEntity> = {};
    const ownerId = resolveOwnerFilter(currentUser, query.userId, 'orders');
    if (ownerId !== undefined) where.userId = ownerId;
    if (query.status !== undefined) where.status = query.status;
    const [orders, total] = await this.orderRepository.findAndCount({
      where,
      relations: { items: { product: true } },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });
    return PaginatedResponseDto.of(
      orders.map((order) => OrderResponseDto.fromEntity(order)),
      total,
      query.page,
      query.limit,
    );
  }
  async findOneOrFail(
    id: number,
    currentUser: UserResponseDto,
  ): Promise<OrderEntity> {
    const order = await this.loadOrFail(id);
    assertOwnership(currentUser, order.userId, 'an order');
    return order;
  }
  async updateStatus(
    id: number,
    dto: UpdateOrderStatusDto,
  ): Promise<OrderEntity> {
    const order = await this.loadOrFail(id);
    if (order.status === dto.status) return order;
    if (!canTransition(order.status, dto.status))
      throw new ConflictException(
        `An order cannot move from ${order.status} to ${dto.status}`,
      );
    await this.dataSource.transaction(async (manager) => {
      // Preserve the existing compare-and-swap status transition.
      const result = await manager
        .getRepository(OrderEntity)
        .update({ id, status: order.status }, { status: dto.status });
      if (result.affected !== 1)
        throw new ConflictException(
          'Order status was modified concurrently. Please retry.',
        );
      if (dto.status === OrderStatus.CANCELLED && order.inventoryReservationId)
        await this.operations.enqueueRelease(
          manager,
          order.inventoryReservationId,
        );
    });
    if (dto.status === OrderStatus.CANCELLED && order.inventoryReservationId)
      await this.attemptRelease(order.inventoryReservationId);
    return this.loadOrFail(id);
  }
  async remove(id: number): Promise<void> {
    const reservationId = await this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(OrderEntity);
      const order = await orders.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(`Order with id ${id} not found`);
      const release =
        order.inventoryReservationId &&
        [OrderStatus.PENDING, OrderStatus.CONFIRMED].includes(order.status)
          ? order.inventoryReservationId
          : undefined;
      if (release) await this.operations.enqueueRelease(manager, release);
      await orders.remove(order);
      return release;
    });
    // Shipped/delivered sales stay deducted; deleting history is not a return.
    if (reservationId) await this.attemptRelease(reservationId);
  }
  private async attemptRelease(id: string): Promise<void> {
    try {
      await this.operations.tryCompensate(id);
    } catch {
      this.logger.warn({
        event: 'inventory_release_pending',
        reservationId: id,
      });
    }
  }
  private async loadOrFail(id: number): Promise<OrderEntity> {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: { items: { product: true } },
    });
    if (!order) throw new NotFoundException(`Order with id ${id} not found`);
    return order;
  }
  private totalOf(items: { unitPrice: number; quantity: number }[]): number {
    return (
      items.reduce(
        (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
        0,
      ) / 100
    );
  }
}

export function generateOrderNumber(date: Date = new Date()): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from(randomBytes(6))
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');
  return `ORD-${day}-${suffix}`;
}
