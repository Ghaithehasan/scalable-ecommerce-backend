import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { ProductCacheService } from '../src/products/product-cache.service';
import { ProductEntity } from '../src/products/entities/product.entity';

jest.mock('ioredis', () => ({ Redis: jest.fn() }));

describe('ProductCacheService (Redis adapter)', () => {
  let client: {
    status: string;
    on: jest.Mock;
    connect: jest.Mock;
    disconnect: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  let products: { find: jest.Mock };
  let service: ProductCacheService;
  const sample = () =>
    Object.assign(new ProductEntity(), {
      id: 7,
      name: 'Headphones',
      description: null,
      price: 49.99,
      categoryId: 2,
      isActive: true,
      createdAt: new Date('2026-01-01Z'),
      updatedAt: new Date('2026-01-02Z'),
      category: {
        id: 2,
        name: 'Audio',
        slug: 'audio',
        description: null,
        isActive: true,
        createdAt: new Date('2026-01-01Z'),
        updatedAt: new Date('2026-01-02Z'),
      },
      images: [
        {
          id: 4,
          imageUrl: 'https://example.com/image.jpg',
          isPrimary: true,
          sortOrder: 0,
        },
      ],
    });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    client = {
      status: 'ready',
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    (Redis as unknown as jest.Mock).mockImplementation(() => client);
    products = { find: jest.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]) };
    service = new ProductCacheService(
      new ConfigService({
        REDIS_URL: 'redis://redis:6379',
        PRODUCT_CACHE_TTL_SECONDS: '7',
      }),
      products as never,
    );
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('serializes catalogue fields without stock and restores entity dates and relations', async () => {
    await service.set(sample());
    const [key, raw, expiry, ttl] = client.set.mock.calls[0];
    expect([key, expiry, ttl]).toEqual(['product:7', 'EX', 7]);
    expect(raw).not.toContain('availableQuantity');
    client.get.mockResolvedValueOnce(raw);
    const cached = await service.get(7);
    expect(cached).toMatchObject({
      id: 7,
      price: 49.99,
      category: { name: 'Audio' },
      images: [{ id: 4 }],
    });
    expect(cached?.createdAt).toBeInstanceOf(Date);
    expect(cached?.category.updatedAt).toBeInstanceOf(Date);
  });

  it('treats missing and malformed data as cache misses', async () => {
    expect(await service.get(7)).toBeNull();
    client.get.mockResolvedValueOnce('{invalid json');
    expect(await service.get(7)).toBeNull();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('falls back on Redis errors and makes writes and invalidation best-effort', async () => {
    client.get.mockRejectedValueOnce(new Error('offline'));
    expect(await service.get(7)).toBeNull();
    client.set.mockRejectedValueOnce(new Error('offline'));
    await expect(service.set(sample())).resolves.toBeUndefined();
    client.del.mockRejectedValueOnce(new Error('offline'));
    await expect(service.invalidate(7)).resolves.toBeUndefined();
    client.status = 'reconnecting';
    expect(await service.get(7)).toBeNull();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('targets only products belonging to an edited category', async () => {
    await service.invalidateCategory(2);
    expect(products.find).toHaveBeenCalledWith({
      select: { id: true },
      where: { categoryId: 2 },
    });
    expect(client.del).toHaveBeenCalledWith('product:7', 'product:8');
  });

  it('is disabled when REDIS_URL is absent and rejects an invalid TTL', async () => {
    const disabled = new ProductCacheService(
      new ConfigService({}),
      products as never,
    );
    expect(await disabled.get(7)).toBeNull();
    await disabled.set(sample());
    expect(client.set).not.toHaveBeenCalled();
    expect(
      () =>
        new ProductCacheService(
          new ConfigService({ PRODUCT_CACHE_TTL_SECONDS: '0' }),
          products as never,
        ),
    ).toThrow('PRODUCT_CACHE_TTL_SECONDS');
  });
});
