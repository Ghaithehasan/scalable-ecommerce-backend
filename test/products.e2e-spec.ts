import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';

import { CategoriesController } from '../src/products/categories.controller';
import { CategoriesService } from '../src/products/categories.service';
import { CategoryEntity } from '../src/products/entities/category.entity';
import { ProductEntity } from '../src/products/entities/product.entity';
import { ProductImageEntity } from '../src/products/entities/product-image.entity';
import { ProductsController } from '../src/products/products.controller';
import { ProductsService } from '../src/products/products.service';
import { createHarness, CUSTOMER, Harness, RESPONSIBLE } from './test-harness';

interface FindAndCountArgs {
  where?: { categoryId?: number; isActive?: boolean };
  skip?: number;
  take?: number;
  order?: Record<string, string>;
}

function makeCategory(id: number, name: string): CategoryEntity {
  return Object.assign(new CategoryEntity(), {
    id,
    name,
    slug: name.toLowerCase(),
    description: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function makeProduct(
  id: number,
  overrides: Partial<ProductEntity> = {},
): ProductEntity {
  return Object.assign(new ProductEntity(), {
    id,
    name: `Product ${id}`,
    description: null,
    price: 100 + id,
    categoryId: 1,
    category: makeCategory(1, 'Phones'),
    isActive: true,
    images: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

describe('Products and categories HTTP API (mocked repositories)', () => {
  let harness: Harness;
  let productRepository: Record<string, jest.Mock>;
  let categoryRepository: Record<string, jest.Mock>;
  let imageRepository: Record<string, jest.Mock>;

  const createProductBody = {
    name: 'Wireless Headphones',
    description: 'Over-ear, 30h battery',
    price: 249.99,
    categoryId: 1,
    images: [
      { imageUrl: 'https://cdn.example.com/a.jpg' },
      { imageUrl: 'https://cdn.example.com/b.jpg', sortOrder: 2 },
    ],
  };

  beforeEach(async () => {
    const catalogue = [
      makeProduct(1),
      makeProduct(2, { categoryId: 2 }),
      makeProduct(3, { isActive: false }),
    ];

    productRepository = {
      findAndCount: jest
        .fn()
        .mockImplementation(async (args: FindAndCountArgs) => {
          const where = args.where ?? {};
          const matching = catalogue.filter(
            (product) =>
              (where.categoryId === undefined ||
                product.categoryId === where.categoryId) &&
              (where.isActive === undefined ||
                product.isActive === where.isActive),
          );
          const skip = args.skip ?? 0;
          const take = args.take ?? matching.length;
          return [matching.slice(skip, skip + take), matching.length];
        }),
      findOne: jest
        .fn()
        .mockImplementation(
          async (args: { where: { id: number } }) =>
            catalogue.find((product) => product.id === args.where.id) ?? null,
        ),
      create: jest
        .fn()
        .mockImplementation((data: Partial<ProductEntity>) =>
          Object.assign(new ProductEntity(), data),
        ),
      save: jest.fn().mockImplementation(async (product: ProductEntity) => {
        const saved = Object.assign(product, {
          id: product.id ?? 99,
          createdAt: new Date('2026-02-01T00:00:00Z'),
          updatedAt: new Date('2026-02-01T00:00:00Z'),
          category: makeCategory(product.categoryId, 'Phones'),
        });
        if (!catalogue.some((existing) => existing.id === saved.id)) {
          catalogue.push(saved);
        }
        return saved;
      }),
      remove: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };

    categoryRepository = {
      findOneBy: jest
        .fn()
        .mockImplementation(async ({ id }: { id: number }) =>
          id === 1 || id === 2 ? makeCategory(id, 'Phones') : null,
        ),
      findAndCount: jest
        .fn()
        .mockResolvedValue([[makeCategory(1, 'Phones')], 1]),
      create: jest
        .fn()
        .mockImplementation((data: Partial<CategoryEntity>) =>
          Object.assign(new CategoryEntity(), data),
        ),
      save: jest
        .fn()
        .mockImplementation(async (category: CategoryEntity) =>
          Object.assign(category, { id: category.id ?? 50 }),
        ),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    imageRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      save: jest.fn().mockImplementation(async (rows: unknown) => rows),
      create: jest.fn().mockImplementation((data: unknown) => data),
    };

    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
            runInTransaction({
              getRepository: (entity: unknown) =>
                entity === ProductImageEntity
                  ? imageRepository
                  : productRepository,
            }),
        ),
    };

    harness = await createHarness({
      controllers: [ProductsController, CategoriesController],
      providers: [
        ProductsService,
        CategoriesService,
        {
          provide: getRepositoryToken(ProductEntity),
          useValue: productRepository,
        },
        {
          provide: getRepositoryToken(CategoryEntity),
          useValue: categoryRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    });
  });

  afterEach(async () => {
    await harness?.app.close();
  });

  describe('listing, filtering and pagination', () => {
    it('pushes the category filter and the page window into the query', async () => {
      harness.actAs(RESPONSIBLE);

      const response = await request(harness.app.getHttpServer())
        .get('/products?categoryId=2&page=1&limit=5')
        .expect(200);

      const args = productRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.where?.categoryId).toBe(2);
      expect(args.skip).toBe(0);
      expect(args.take).toBe(5);
      // Deterministic ordering: a tie on createdAt is broken by the id.
      expect(args.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
      expect(response.body.meta).toMatchObject({
        page: 1,
        limit: 5,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('computes the offset of a later page', async () => {
      await request(harness.app.getHttpServer())
        .get('/products?page=3&limit=10')
        .expect(200);

      const args = productRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('returns 404 when filtering by a category that does not exist', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/products?categoryId=999')
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        path: '/products?categoryId=999',
      });
      expect(response.body.timestamp).toEqual(expect.any(String));
    });

    it.each([
      '/products?page=0',
      '/products?limit=0',
      '/products?limit=101',
      '/products?categoryId=abc',
      '/products?isActive=maybe',
      '/products?unknown=1',
    ])('rejects the invalid query %s', async (url) => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer()).get(url).expect(400);
    });

    it('restricts a customer to active products even when asked otherwise', async () => {
      await request(harness.app.getHttpServer())
        .get('/products?isActive=false')
        .expect(200);

      const args = productRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.where?.isActive).toBe(true);
    });

    it('lets a RESPONSIBLE user list deactivated products', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .get('/products?isActive=false')
        .expect(200);

      const args = productRepository.findAndCount.mock
        .calls[0][0] as FindAndCountArgs;
      expect(args.where?.isActive).toBe(false);
    });
  });

  describe('reading a single product', () => {
    it('returns the product with its category and images', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/products/1')
        .expect(200);

      expect(response.body).toMatchObject({
        id: 1,
        price: 101,
        categoryId: 1,
        isActive: true,
      });
      expect(response.body.category).toMatchObject({ id: 1 });
    });

    it('hides a deactivated product from a customer', async () => {
      await request(harness.app.getHttpServer()).get('/products/3').expect(404);
    });

    it('shows a deactivated product to a RESPONSIBLE user', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer()).get('/products/3').expect(200);
    });

    it('returns 404 for an unknown product and 400 for a non-numeric id', async () => {
      await request(harness.app.getHttpServer())
        .get('/products/999')
        .expect(404);
      await request(harness.app.getHttpServer())
        .get('/products/abc')
        .expect(400);
    });
  });

  describe('writing the catalogue', () => {
    it('refuses creation, update and deletion for a customer', async () => {
      await request(harness.app.getHttpServer())
        .post('/products')
        .send(createProductBody)
        .expect(403);
      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ price: 1 })
        .expect(403);
      await request(harness.app.getHttpServer())
        .delete('/products/1')
        .expect(403);
    });

    it('creates a product and marks the first image as primary', async () => {
      harness.actAs(RESPONSIBLE);

      const response = await request(harness.app.getHttpServer())
        .post('/products')
        .send(createProductBody)
        .expect(201);

      const saved = productRepository.save.mock.calls[0][0] as ProductEntity;
      expect(saved.images).toEqual([
        {
          imageUrl: 'https://cdn.example.com/a.jpg',
          isPrimary: true,
          sortOrder: 0,
        },
        {
          imageUrl: 'https://cdn.example.com/b.jpg',
          isPrimary: false,
          sortOrder: 2,
        },
      ]);
      expect(response.body).toMatchObject({
        name: createProductBody.name,
        price: createProductBody.price,
        isActive: true,
      });
    });

    it('returns 404 when the referenced category does not exist', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .post('/products')
        .send({ ...createProductBody, categoryId: 999 })
        .expect(404);
      expect(productRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an image set with two primary images', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .post('/products')
        .send({
          ...createProductBody,
          images: [
            { imageUrl: 'https://cdn.example.com/a.jpg', isPrimary: true },
            { imageUrl: 'https://cdn.example.com/b.jpg', isPrimary: true },
          ],
        })
        .expect(400);
    });

    it.each([
      { price: -1 },
      { price: 10.123 },
      { price: 'free' },
      { categoryId: 0 },
      { name: '' },
      { images: [{ imageUrl: 'not-a-url' }] },
      { stockQuantity: 5 },
    ])('rejects the invalid product body %o', async (override) => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .post('/products')
        .send({ ...createProductBody, ...override })
        .expect(400);
    });

    // PostgreSQL answers an ON DELETE RESTRICT refusal with 23001
    // (restrict_violation), and a plain foreign key check with 23503.
    it.each(['23001', '23503'])(
      'refuses to delete a product that an order already references (%s)',
      async (code) => {
        harness.actAs(RESPONSIBLE);
        productRepository.remove.mockRejectedValueOnce(
          new QueryFailedError(
            'DELETE FROM products',
            [],
            Object.assign(new Error('restrict violation'), { code }),
          ),
        );

        const response = await request(harness.app.getHttpServer())
          .delete('/products/1')
          .expect(409);

        expect(response.body.message).toContain('isActive');
      },
    );

    it('deletes a product that no order references', async () => {
      harness.actAs(RESPONSIBLE);
      await request(harness.app.getHttpServer())
        .delete('/products/1')
        .expect(204);
      expect(productRepository.remove).toHaveBeenCalled();
    });

    it('keeps validating the body on a partial update', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ price: -5 })
        .expect(400);
      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ name: '' })
        .expect(400);
      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ stockQuantity: 3 })
        .expect(400);
    });

    it('returns 404 when an update moves a product to an unknown category', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ categoryId: 999 })
        .expect(404);
    });

    it('replaces the image set inside a transaction on update', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .patch('/products/1')
        .send({ images: [{ imageUrl: 'https://cdn.example.com/new.jpg' }] })
        .expect(200);

      expect(imageRepository.delete).toHaveBeenCalledWith({ productId: 1 });
      expect(imageRepository.save).toHaveBeenCalled();
    });
  });

  describe('categories', () => {
    it('derives a slug from the name', async () => {
      harness.actAs(RESPONSIBLE);

      await request(harness.app.getHttpServer())
        .post('/categories')
        .send({ name: 'Home & Kitchen' })
        .expect(201);

      const saved = categoryRepository.save.mock.calls[0][0] as CategoryEntity;
      expect(saved.slug).toBe('home-kitchen');
    });

    it('reports a duplicate slug as a conflict', async () => {
      harness.actAs(RESPONSIBLE);
      categoryRepository.save.mockRejectedValueOnce(
        new QueryFailedError(
          'INSERT INTO categories',
          [],
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        ),
      );

      await request(harness.app.getHttpServer())
        .post('/categories')
        .send({ name: 'Phones' })
        .expect(409);
    });

    it('refuses to delete a category that still classifies products', async () => {
      harness.actAs(RESPONSIBLE);
      categoryRepository.remove.mockRejectedValueOnce(
        new QueryFailedError(
          'DELETE FROM categories',
          [],
          Object.assign(new Error('restrict violation'), { code: '23001' }),
        ),
      );

      await request(harness.app.getHttpServer())
        .delete('/categories/1')
        .expect(409);
    });

    it('does not let a customer change the categories', async () => {
      harness.actAs(CUSTOMER);
      await request(harness.app.getHttpServer())
        .post('/categories')
        .send({ name: 'Toys' })
        .expect(403);
    });
  });
});
