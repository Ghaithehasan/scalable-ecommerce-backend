import { status } from '@grpc/grpc-js';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import request from 'supertest';

import { OrderEntity } from '../src/orders/entities/order.entity';
import { OrderItemEntity } from '../src/orders/entities/order-item.entity';
import { OrderStatus } from '../src/orders/enums/order-status.enum';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { ProductEntity } from '../src/products/entities/product.entity';
import { InventoryClient } from '../src/inventory/inventory.client';
import { ProductsService } from '../src/products/products.service';
import {
  createHarness,
  CUSTOMER,
  Harness,
  OTHER_CUSTOMER,
  RESPONSIBLE,
} from './test-harness';

interface FindAndCountArgs {
  where?: { userId?: number; status?: OrderStatus };
  skip?: number;
  take?: number;
  order?: Record<string, string>;
}

function makeProduct(
  id: number,
  price: number,
  isActive = true,
): ProductEntity {
  return Object.assign(new ProductEntity(), {
    id,
    name: `Product ${id}`,
    description: null,
    price,
    categoryId: 1,
    isActive,
    images: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function makeOrder(
  id: number,
  userId: number,
  status: OrderStatus = OrderStatus.PENDING,
): OrderEntity {
  return Object.assign(new OrderEntity(), {
    id,
    orderNumber: `ORD-20260101-00000${id}`,
    userId,
    status,
    totalAmount: 250,
    items: [
      Object.assign(new OrderItemEntity(), {
        id: id * 10,
        orderId: id,
        productId: 1,
        product: makeProduct(1, 125),
        quantity: 2,
        unitPrice: 125,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('Orders HTTP API (mocked repositories)', () => {
  let harness: Harness;
  let orderRepository: Record<string, jest.Mock>;
  let inventoryClient: Record<string, jest.Mock>;
  let orders: OrderEntity[];

  // Order 1 belongs to CUSTOMER (id 10), order 2 to OTHER_CUSTOMER (id 11).
  beforeEach(async () => {
    orders = [makeOrder(1, CUSTOMER.id), makeOrder(2, OTHER_CUSTOMER.id)];

    const catalogue = [
      makeProduct(1, 125),
      makeProduct(2, 19.99),
      makeProduct(3, 50, false),
    ];

    orderRepository = {
      findAndCount: jest
        .fn()
        .mockImplementation(async (args: FindAndCountArgs) => {
          const where = args.where ?? {};
          const matching = orders.filter(
            (order) =>
              (where.userId === undefined || order.userId === where.userId) &&
              (where.status === undefined || order.status === where.status),
          );
          return [matching, matching.length];
        }),
      findOne: jest
        .fn()
        .mockImplementation(
          async (args: { where: { id: number } }) =>
            orders.find((order) => order.id === args.where.id) ?? null,
        ),
      create: jest
        .fn()
        .mockImplementation((data: Partial<OrderEntity>) =>
          Object.assign(new OrderEntity(), data),
        ),
      save: jest.fn().mockImplementation(async (order: OrderEntity) => {
        const saved = Object.assign(order, { id: order.id ?? 3 });
        if (!orders.some((existing) => existing.id === saved.id)) {
          orders.push(
            Object.assign(saved, {
              createdAt: new Date('2026-02-01T00:00:00Z'),
              updatedAt: new Date('2026-02-01T00:00:00Z'),
            }),
          );
        }
        return saved;
      }),
      remove: jest.fn().mockImplementation(async (order: OrderEntity) => {
        orders = orders.filter((existing) => existing.id !== order.id);
        return order;
      }),
    };

    const orderItemRepository = {
      create: jest
        .fn()
        .mockImplementation((data: Partial<OrderItemEntity>) =>
          Object.assign(new OrderItemEntity(), data),
        ),
    };

    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
            runInTransaction({
              getRepository: (entity: unknown) =>
                entity === OrderItemEntity
                  ? orderItemRepository
                  : orderRepository,
            }),
        ),
    };

    // The real ProductsService supplies the prices, so the price snapshot is
    // exercised through the module boundary rather than around it.
    const productsService = {
      findByIds: jest
        .fn()
        .mockImplementation(async (ids: number[]) =>
          catalogue.filter((product) => ids.includes(product.id)),
        ),
    };

    // The warehouse is a separate service reached over gRPC; here it is
    // mocked so the order flow can be driven through every answer it gives.
    inventoryClient = {
      reserveStock: jest
        .fn()
        .mockResolvedValue({ reserved: true, shortages: [] }),
      releaseStock: jest.fn().mockResolvedValue({ released: true }),
      getStock: jest.fn().mockResolvedValue(new Map()),
    };

    harness = await createHarness({
      controllers: [OrdersController],
      providers: [
        OrdersService,
        { provide: getRepositoryToken(OrderEntity), useValue: orderRepository },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: ProductsService, useValue: productsService },
        { provide: InventoryClient, useValue: inventoryClient },
      ],
    });
  });

  afterEach(async () => {
    await harness?.app.close();
  });

  describe('placing an order', () => {
    it('prices the lines from the catalogue and totals them', async () => {
      const response = await request(harness.app.getHttpServer())
        .post('/orders')
        .send({
          items: [
            { productId: 1, quantity: 2 },
            { productId: 2, quantity: 3 },
          ],
        })
        .expect(201);

      // 125.00 * 2 + 19.99 * 3 = 309.97
      expect(response.body).toMatchObject({
        userId: CUSTOMER.id,
        status: OrderStatus.PENDING,
        totalAmount: 309.97,
      });
      expect(response.body.orderNumber).toMatch(/^ORD-\d{8}-[A-Z2-9]{6}$/);
      expect(response.body.items).toHaveLength(2);
      expect(response.body.items[0]).toMatchObject({
        productId: 1,
        quantity: 2,
        unitPrice: 125,
        lineTotal: 250,
      });
    });

    it('always records the authenticated user as the owner', async () => {
      harness.actAs(OTHER_CUSTOMER);

      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({ items: [{ productId: 1, quantity: 1 }] })
        .expect(201);

      const saved = orderRepository.save.mock.calls[0][0] as OrderEntity;
      expect(saved.userId).toBe(OTHER_CUSTOMER.id);
    });

    it('rejects a price supplied by the client', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({ items: [{ productId: 1, quantity: 1, unitPrice: 0.01 }] })
        .expect(400);
    });

    it('rejects the same product twice in one order', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({
          items: [
            { productId: 1, quantity: 1 },
            { productId: 1, quantity: 2 },
          ],
        })
        .expect(400);
    });

    it('returns 404 for a product that does not exist', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({ items: [{ productId: 999, quantity: 1 }] })
        .expect(404);
    });

    it('returns 400 for a product that is not on sale', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({ items: [{ productId: 3, quantity: 1 }] })
        .expect(400);
    });

    it.each([
      { items: [] },
      { items: [{ productId: 1, quantity: 0 }] },
      { items: [{ productId: 1, quantity: 1.5 }] },
      { items: [{ productId: 0, quantity: 1 }] },
      { items: [{ quantity: 1 }] },
      { items: 'everything' },
    ])('rejects the invalid order body %o', async (body) => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(400);
    });
  });

  describe('ownership of orders', () => {
    it('scopes a customer list to their own orders', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/orders')
        .expect(200);

      const args = orderRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.where?.userId).toBe(CUSTOMER.id);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].userId).toBe(CUSTOMER.id);
    });

    it('refuses a customer that asks for another user orders', async () => {
      const response = await request(harness.app.getHttpServer())
        .get(`/orders?userId=${OTHER_CUSTOMER.id}`)
        .expect(403);

      expect(response.body).toMatchObject({ statusCode: 403 });
      expect(orderRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('lets a RESPONSIBLE user read every order and filter by user', async () => {
      harness.actAs(RESPONSIBLE);

      const all = await request(harness.app.getHttpServer())
        .get('/orders')
        .expect(200);
      expect(all.body.data).toHaveLength(2);

      await request(harness.app.getHttpServer())
        .get(`/orders?userId=${OTHER_CUSTOMER.id}`)
        .expect(200);
      const args = orderRepository.findAndCount.mock
        .calls[1][0] as FindAndCountArgs;
      expect(args.where?.userId).toBe(OTHER_CUSTOMER.id);
    });

    it('refuses a customer reading an order that belongs to someone else', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/orders/2')
        .expect(403);

      expect(response.body.message).toContain('another user');
    });

    it('lets a customer read their own order', async () => {
      await request(harness.app.getHttpServer()).get('/orders/1').expect(200);
    });

    it('lets a RESPONSIBLE user read any order', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer()).get('/orders/2').expect(200);
    });

    it('returns 404 for an unknown order and 400 for a non-numeric id', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer()).get('/orders/999').expect(404);
      await request(harness.app.getHttpServer()).get('/orders/abc').expect(400);
    });

    it('filters a page by status and keeps the ordering deterministic', async () => {
      await request(harness.app.getHttpServer())
        .get('/orders?status=PENDING&page=2&limit=5')
        .expect(200);

      const args = orderRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.where?.status).toBe(OrderStatus.PENDING);
      expect(args.skip).toBe(5);
      expect(args.take).toBe(5);
      expect(args.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
    });

    it('rejects an unknown status value', async () => {
      await request(harness.app.getHttpServer())
        .get('/orders?status=ARCHIVED')
        .expect(400);
    });
  });

  describe('changing the status of an order', () => {
    it('refuses a customer changing the status of their own order', async () => {
      await request(harness.app.getHttpServer())
        .patch('/orders/1/status')
        .send({ status: OrderStatus.CONFIRMED })
        .expect(403);
    });

    it('lets a RESPONSIBLE user confirm a pending order', async () => {
      harness.actAs(RESPONSIBLE);

      const response = await request(harness.app.getHttpServer())
        .patch('/orders/1/status')
        .send({ status: OrderStatus.CONFIRMED })
        .expect(200);

      expect(response.body.status).toBe(OrderStatus.CONFIRMED);
    });

    it('rejects a move that skips a step', async () => {
      harness.actAs(RESPONSIBLE);

      const response = await request(harness.app.getHttpServer())
        .patch('/orders/1/status')
        .send({ status: OrderStatus.DELIVERED })
        .expect(409);

      expect(response.body.message).toContain('cannot move from PENDING');
    });

    it('rejects any move out of a final status', async () => {
      harness.actAs(RESPONSIBLE);
      orders[0].status = OrderStatus.CANCELLED;

      await request(harness.app.getHttpServer())
        .patch('/orders/1/status')
        .send({ status: OrderStatus.CONFIRMED })
        .expect(409);
    });

    it('rejects an unknown status', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer())
        .patch('/orders/1/status')
        .send({ status: 'ARCHIVED' })
        .expect(400);
    });
  });

  /**
   * Requirement 2: the application reserves stock from the inventory service
   * before it writes an order, and gives it back if anything afterwards goes
   * wrong.
   */
  describe('stock reservation over gRPC', () => {
    const body = { items: [{ productId: 1, quantity: 2 }] };

    const grpcError = (code: status, details: string): Error =>
      Object.assign(new Error(details), { code, details });

    it('reserves the whole basket in ONE call before writing anything', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({
          items: [
            { productId: 1, quantity: 2 },
            { productId: 2, quantity: 3 },
          ],
        })
        .expect(201);

      expect(inventoryClient.reserveStock).toHaveBeenCalledTimes(1);

      const [reservationId, items] = inventoryClient.reserveStock.mock.calls[0];
      // A UUID the caller generated, so retries and compensation can name it.
      expect(reservationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // The contract takes strings, whatever our own id type is.
      expect(items).toEqual([
        { productId: '1', quantity: 2 },
        { productId: '2', quantity: 3 },
      ]);
      expect(inventoryClient.releaseStock).not.toHaveBeenCalled();
    });

    it('refuses the order with 409 and the shortages when stock is short', async () => {
      inventoryClient.reserveStock.mockResolvedValueOnce({
        reserved: false,
        shortages: [{ productId: '1', requested: 2, available: 0 }],
      });

      const response = await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(409);

      expect(response.body.shortages).toEqual([
        { productId: 1, requested: 2, available: 0 },
      ]);
      // Nothing was reserved, so there is nothing to give back.
      expect(inventoryClient.releaseStock).not.toHaveBeenCalled();
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('does not write an order when the reservation is refused', async () => {
      inventoryClient.reserveStock.mockResolvedValueOnce({
        reserved: false,
        shortages: [{ productId: '1', requested: 2, available: 1 }],
      });

      await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(409);

      expect(orders).toHaveLength(2);
    });

    it.each([
      ['the warehouse is down', status.UNAVAILABLE],
      ['the warehouse does not answer in time', status.DEADLINE_EXCEEDED],
    ])('answers 503 when %s', async (_name, code) => {
      inventoryClient.reserveStock.mockRejectedValueOnce(
        grpcError(code, 'inventory is not reachable'),
      );

      const response = await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(503);

      // The customer is told plainly, and told the order was NOT placed.
      expect(String(response.body.message)).toMatch(/not placed/i);
      expect(orderRepository.save).not.toHaveBeenCalled();
      // A reserve that timed out may still have succeeded on the server, so
      // the units are handed back regardless.
      expect(inventoryClient.releaseStock).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation when saving the order fails', async () => {
      const databaseError = new Error('database went away');
      orderRepository.save.mockRejectedValueOnce(databaseError);

      await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(500);

      expect(inventoryClient.reserveStock).toHaveBeenCalledTimes(1);
      expect(inventoryClient.releaseStock).toHaveBeenCalledTimes(1);

      // The same reservation id, otherwise the compensation would release
      // nothing and the stock would stay held forever.
      const reservedId = inventoryClient.reserveStock.mock.calls[0][0];
      const releasedId = inventoryClient.releaseStock.mock.calls[0][0];
      expect(releasedId).toBe(reservedId);
    });

    it('still answers the original error when the compensation also fails', async () => {
      orderRepository.save.mockRejectedValueOnce(new Error('database is gone'));
      inventoryClient.releaseStock.mockRejectedValueOnce(
        grpcError(status.UNAVAILABLE, 'inventory is not reachable either'),
      );

      // The customer hears about the real problem, not about the failed
      // clean-up attempt.
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(500);
    });

    it('retries only the transaction, never the reservation', async () => {
      // An order-number collision makes the write retry; the reservation must
      // not be repeated, or the basket would be reserved twice.
      orderRepository.save.mockRejectedValueOnce(
        new QueryFailedError(
          'INSERT INTO orders',
          [],
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        ),
      );

      await request(harness.app.getHttpServer())
        .post('/orders')
        .send(body)
        .expect(201);

      expect(orderRepository.save).toHaveBeenCalledTimes(2);
      expect(inventoryClient.reserveStock).toHaveBeenCalledTimes(1);
      expect(inventoryClient.releaseStock).not.toHaveBeenCalled();
    });

    it('does not reserve when the request never reaches the handler', async () => {
      await request(harness.app.getHttpServer())
        .post('/orders')
        .send({ items: [] })
        .expect(400);

      expect(inventoryClient.reserveStock).not.toHaveBeenCalled();
    });
  });

  describe('deleting an order', () => {
    it('refuses a customer deleting their own order', async () => {
      await request(harness.app.getHttpServer())
        .delete('/orders/1')
        .expect(403);
      expect(orderRepository.remove).not.toHaveBeenCalled();
    });

    it('lets a RESPONSIBLE user delete an order', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer())
        .delete('/orders/1')
        .expect(204);
      expect(orderRepository.remove).toHaveBeenCalled();
    });
  });
});
