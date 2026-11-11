import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { Repository } from 'typeorm';

import { ProductResponseDto } from './dto/product-response.dto';
import { CategoryEntity } from './entities/category.entity';
import { ProductEntity } from './entities/product.entity';
import { ProductImageEntity } from './entities/product-image.entity';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid cached object');
  return value as Record<string, unknown>;
}

function date(value: unknown): Date {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid cached date');
  return new Date(value);
}

function hydrate(raw: string, id: number): ProductEntity {
  const entry = record(JSON.parse(raw));
  const p = record(entry.product);
  const c = record(p.category);
  if (
    entry.version !== 1 ||
    p.id !== id ||
    typeof p.name !== 'string' ||
    !(p.description === null || typeof p.description === 'string') ||
    typeof p.price !== 'number' ||
    !Number.isFinite(p.price) ||
    p.price < 0 ||
    typeof p.isActive !== 'boolean' ||
    !Number.isSafeInteger(p.categoryId) ||
    c.id !== p.categoryId ||
    typeof c.name !== 'string' ||
    typeof c.slug !== 'string' ||
    typeof c.isActive !== 'boolean' ||
    !(c.description === null || typeof c.description === 'string') ||
    !Array.isArray(p.images)
  )
    throw new Error('Invalid cached product');

  const images = p.images.map((value) => {
    const image = record(value);
    if (
      !Number.isSafeInteger(image.id) ||
      typeof image.imageUrl !== 'string' ||
      typeof image.isPrimary !== 'boolean' ||
      !Number.isInteger(image.sortOrder)
    )
      throw new Error('Invalid cached image');
    return Object.assign(new ProductImageEntity(), {
      id: image.id,
      productId: id,
      imageUrl: image.imageUrl,
      isPrimary: image.isPrimary,
      sortOrder: image.sortOrder,
    });
  });
  return Object.assign(new ProductEntity(), {
    id,
    name: p.name,
    description: p.description,
    price: p.price,
    categoryId: p.categoryId,
    isActive: p.isActive,
    images,
    createdAt: date(p.createdAt),
    updatedAt: date(p.updatedAt),
    category: Object.assign(new CategoryEntity(), {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      isActive: c.isActive,
      createdAt: date(c.createdAt),
      updatedAt: date(c.updatedAt),
    }),
  });
}

/** Display cache only. Prices used by checkout continue to come from PostgreSQL. */
@Injectable()
export class ProductCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductCacheService.name);
  private readonly redis?: Redis;
  private readonly ttlSeconds: number;
  private unavailableLogged = false;

  constructor(
    config: ConfigService,
    @InjectRepository(ProductEntity)
    private readonly products: Repository<ProductEntity>,
  ) {
    this.ttlSeconds = Number(
      config.get<string>('PRODUCT_CACHE_TTL_SECONDS') ?? 60,
    );
    if (
      !Number.isInteger(this.ttlSeconds) ||
      this.ttlSeconds < 1 ||
      this.ttlSeconds > 86400
    )
      throw new Error(
        'PRODUCT_CACHE_TTL_SECONDS must be an integer from 1 to 86400',
      );
    const url = config.get<string>('REDIS_URL');
    if (!url) return;
    this.redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 500,
      commandTimeout: 250,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
    });
    this.redis.on('error', () => this.warnUnavailable());
    this.redis.on('ready', () => {
      this.unavailableLogged = false;
    });
  }

  onModuleInit(): void {
    if (this.redis)
      void this.redis.connect().catch(() => this.warnUnavailable());
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  async get(id: number): Promise<ProductEntity | null> {
    if (this.redis?.status !== 'ready') return null;
    try {
      const raw = await this.redis.get(`product:${id}`);
      return raw === null ? null : hydrate(raw, id);
    } catch {
      this.warnUnavailable();
      return null;
    }
  }

  async set(product: ProductEntity): Promise<void> {
    if (this.redis?.status !== 'ready') return;
    try {
      // Use the public catalogue shape; stock is deliberately omitted.
      const { availableQuantity: _stock, ...catalogue } =
        ProductResponseDto.fromEntity(product);
      await this.redis.set(
        `product:${product.id}`,
        JSON.stringify({ version: 1, product: catalogue }),
        'EX',
        this.ttlSeconds,
      );
    } catch {
      this.warnUnavailable();
    }
  }

  async invalidate(id: number): Promise<void> {
    if (!this.redis) return;
    try {
      if (this.redis.status !== 'ready') throw new Error('Redis unavailable');
      await this.redis.del(`product:${id}`);
    } catch {
      this.logger.warn(
        `Product ${id} cache invalidation failed; old data may remain until TTL expiry`,
      );
    }
  }

  async invalidateCategory(categoryId: number): Promise<void> {
    if (!this.redis) return;
    try {
      if (this.redis.status !== 'ready') throw new Error('Redis unavailable');
      // Target only related product IDs. No Redis-wide scan or flush.
      const products = await this.products.find({
        select: { id: true },
        where: { categoryId },
      });
      for (let start = 0; start < products.length; start += 250) {
        await this.redis.del(
          ...products.slice(start, start + 250).map((p) => `product:${p.id}`),
        );
      }
    } catch {
      this.logger.warn(
        `Category ${categoryId} product-cache invalidation failed; old data may remain until TTL expiry`,
      );
    }
  }

  private warnUnavailable(): void {
    if (!this.unavailableLogged) {
      this.logger.warn(
        'Product cache unavailable or invalid; reads fall back to PostgreSQL',
      );
      this.unavailableLogged = true;
    }
  }
}
