import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';

import {
  assertOwnership,
  resolveOwnerFilter,
} from '../common/authorization/resource-ownership';
import { isUniqueViolation } from '../common/database/postgres-errors';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { ProductsService } from '../products/products.service';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { canTransition, OrderStatus } from './enums/order-status.enum';

/** DECIMAL(10,2) in the ERD: the largest total an order may reach. */
const MAX_TOTAL_AMOUNT = 99999999.99;
const ORDER_NUMBER_ATTEMPTS = 5;

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * Places an order for the authenticated user.
   *
   * Prices are copied from the catalogue into the order lines, so the order
   * keeps the price that applied when it was placed. Stock is deliberately not
   * touched: quantities belong to the warehouse service of requirement 2.
   */
  async create(
    dto: CreateOrderDto,
    currentUser: UserResponseDto,
  ): Promise<OrderEntity> {
    const productIds = dto.items.map((item) => item.productId);
    const duplicate = productIds.find(
      (id, index) => productIds.indexOf(id) !== index,
    );

    if (duplicate !== undefined) {
      throw new BadRequestException(
        `Product ${duplicate} appears more than once; combine it into a single item`,
      );
    }

    // Order numbers carry a random suffix. A collision aborts the transaction
    // in PostgreSQL, so the retry restarts the whole transaction rather than
    // issuing another statement inside the aborted one.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const orderId = await this.placeOrder(dto, currentUser);
        return await this.loadOrFail(orderId);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < ORDER_NUMBER_ATTEMPTS) {
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Writes one order and its lines in a single transaction: the price lookup,
   * the header and the lines commit together, so a half-written order can
   * never report a total that does not match its lines.
   */
  private placeOrder(
    dto: CreateOrderDto,
    currentUser: UserResponseDto,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const products = await this.productsService.findByIds(
        dto.items.map((item) => item.productId),
        manager,
      );
      const productsById = new Map(
        products.map((product) => [product.id, product]),
      );

      const items = dto.items.map((item) => {
        const product = productsById.get(item.productId);

        if (!product) {
          throw new NotFoundException(
            `Product with id ${item.productId} not found`,
          );
        }

        if (!product.isActive) {
          throw new BadRequestException(
            `Product "${product.name}" is not available for sale`,
          );
        }

        return manager.getRepository(OrderItemEntity).create({
          productId: product.id,
          quantity: item.quantity,
          unitPrice: product.price,
        });
      });

      const totalAmount = this.totalOf(items);

      if (totalAmount > MAX_TOTAL_AMOUNT) {
        throw new BadRequestException(
          'The order total exceeds the maximum amount supported',
        );
      }

      const orderRepository = manager.getRepository(OrderEntity);
      const order = orderRepository.create({
        orderNumber: generateOrderNumber(),
        userId: currentUser.id,
        status: OrderStatus.PENDING,
        totalAmount,
        items,
      });

      const saved = await orderRepository.save(order);
      return saved.id;
    });
  }

  async findAll(
    query: QueryOrdersDto,
    currentUser: UserResponseDto,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    const where: FindOptionsWhere<OrderEntity> = {};
    // The single place where "a customer only sees their own orders" is
    // decided for the list endpoint.
    const ownerId = resolveOwnerFilter(currentUser, query.userId, 'orders');

    if (ownerId !== undefined) {
      where.userId = ownerId;
    }

    if (query.status !== undefined) {
      where.status = query.status;
    }

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

  /** Reads one order after checking that the caller is allowed to see it. */
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

    if (order.status === dto.status) {
      return order;
    }

    if (!canTransition(order.status, dto.status)) {
      throw new ConflictException(
        `An order cannot move from ${order.status} to ${dto.status}`,
      );
    }

    order.status = dto.status;
    await this.orderRepository.save(order);
    return this.loadOrFail(id);
  }

  async remove(id: number): Promise<void> {
    const order = await this.loadOrFail(id);
    // order_items.order_id is ON DELETE CASCADE, so the lines go with it.
    await this.orderRepository.remove(order);
  }

  private async loadOrFail(id: number): Promise<OrderEntity> {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: { items: { product: true } },
    });

    if (!order) {
      throw new NotFoundException(`Order with id ${id} not found`);
    }

    return order;
  }

  /** Sums the lines in whole cents so repeated addition cannot drift. */
  private totalOf(items: { unitPrice: number; quantity: number }[]): number {
    const cents = items.reduce(
      (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
      0,
    );

    return cents / 100;
  }
}

/** `ORD-20261028-9F3K2Q`: readable, sortable by day and unguessable. */
export function generateOrderNumber(date: Date = new Date()): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from(randomBytes(6))
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');

  return `ORD-${day}-${suffix}`;
}
