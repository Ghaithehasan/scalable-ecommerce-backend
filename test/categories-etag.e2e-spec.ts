import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';

import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { CategoriesController } from '../src/products/categories.controller';
import { CategoriesService } from '../src/products/categories.service';
import { CategoryEntity } from '../src/products/entities/category.entity';
import { ProductCacheService } from '../src/products/product-cache.service';
import { UsersService } from '../src/users/users.service';
import { CUSTOMER, RESPONSIBLE } from './test-harness';

interface ListOptions {
  where: { isActive?: boolean };
  skip: number;
  take: number;
}

function category(id: number, name: string, isActive = true): CategoryEntity {
  return Object.assign(new CategoryEntity(), {
    id,
    name,
    slug: name.toLowerCase(),
    description: null,
    isActive,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('GET /categories HTTP revalidation (real JWT/roles guards, mocked database)', () => {
  let app: INestApplication<App>;
  let rows: CategoryEntity[];
  let repository: Record<string, jest.Mock>;
  let customerToken: string;
  let managerToken: string;

  beforeEach(async () => {
    rows = [category(1, 'Phones'), category(2, 'Audio', false)];
    let nextId = 3;
    let mutation = 0;
    repository = {
      findAndCount: jest.fn(async (options: ListOptions) => {
        const matching = rows
          .filter(
            (row) =>
              options.where.isActive === undefined ||
              row.isActive === options.where.isActive,
          )
          .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
        return [
          matching.slice(options.skip, options.skip + options.take),
          matching.length,
        ];
      }),
      findOneBy: jest.fn(async ({ id }: { id: number }) => {
        const found = rows.find((row) => row.id === id);
        return found ? structuredClone(found) : null;
      }),
      create: jest.fn((value) => Object.assign(new CategoryEntity(), value)),
      save: jest.fn(async (value: CategoryEntity) => {
        const saved = Object.assign(new CategoryEntity(), value, {
          id: value.id ?? nextId++,
          createdAt: value.createdAt ?? new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++mutation)),
        });
        const index = rows.findIndex((row) => row.id === saved.id);
        if (index < 0) rows.push(saved);
        else rows[index] = saved;
        return saved;
      }),
      remove: jest.fn(async (value: CategoryEntity) => {
        rows = rows.filter((row) => row.id !== value.id);
        return value;
      }),
    };

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'categories-etag-test-only-secret',
          signOptions: { expiresIn: '5m' },
        }),
      ],
      controllers: [CategoriesController],
      providers: [
        CategoriesService,
        { provide: getRepositoryToken(CategoryEntity), useValue: repository },
        {
          provide: ProductCacheService,
          useValue: {
            invalidateCategory: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UsersService,
          useValue: {
            findById: jest.fn(async (id: number) =>
              [CUSTOMER, RESPONSIBLE].find((user) => user.id === id),
            ),
          },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    const jwt = module.get(JwtService);
    customerToken = jwt.sign({ sub: String(CUSTOMER.id), tokenUse: 'access' });
    managerToken = jwt.sign({
      sub: String(RESPONSIBLE.id),
      tokenUse: 'access',
    });
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const read = (path = '/categories') =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${customerToken}`);

  it('returns the existing ordered JSON representation with a weak ETag and private revalidation policy', async () => {
    const response = await read().expect(200).expect('Content-Type', /json/);
    expect(response.headers.etag).toMatch(/^W\/"[^"]+"$/);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.body.data.map((row: { id: number }) => row.id)).toEqual([
      2, 1,
    ]);
    expect(response.body.data[0]).toMatchObject({
      id: 2,
      name: 'Audio',
      slug: 'audio',
      description: null,
      isActive: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(response.body.meta).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it.each(['weak', 'strong', 'list', 'wildcard'] as const)(
    'honors a matching %s If-None-Match without a response body',
    async (kind) => {
      const first = await read().expect(200);
      const etag = first.headers.etag as string;
      const condition =
        kind === 'strong'
          ? etag.replace(/^W\//, '')
          : kind === 'list'
            ? `"unrelated", ${etag}`
            : kind === 'wildcard'
              ? '*'
              : etag;
      const response = await read().set('If-None-Match', condition).expect(304);
      expect(response.text).toBe('');
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers['content-length']).toBeUndefined();
      expect(repository.findAndCount).toHaveBeenCalledTimes(2);
    },
  );

  it('returns 200 for a nonmatching validator', async () => {
    const first = await read().expect(200);
    const response = await read()
      .set('If-None-Match', '"different"')
      .expect(200);
    expect(response.headers.etag).toBe(first.headers.etag);
    expect(response.body).toEqual(first.body);
  });

  it('returns updated data and a new ETag after a successful update', async () => {
    const first = await read().expect(200);
    await request(app.getHttpServer())
      .patch('/categories/1')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Cameras' })
      .expect(200);
    const changed = await read()
      .set('If-None-Match', first.headers.etag)
      .expect(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(
      changed.body.data.find((row: { id: number }) => row.id === 1).name,
    ).toBe('Cameras');
    await read().set('If-None-Match', changed.headers.etag).expect(304);
  });

  it('changes the validator after creating and then deleting a category in the representation', async () => {
    const first = await read().expect(200);
    const created = await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Kitchen' })
      .expect(201);
    const afterCreate = await read()
      .set('If-None-Match', first.headers.etag)
      .expect(200);
    expect(afterCreate.headers.etag).not.toBe(first.headers.etag);
    expect(afterCreate.body.meta.total).toBe(3);
    await request(app.getHttpServer())
      .delete(`/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(204);
    const afterDelete = await read()
      .set('If-None-Match', afterCreate.headers.etag)
      .expect(200);
    expect(afterDelete.headers.etag).not.toBe(afterCreate.headers.etag);
    expect(afterDelete.body).toEqual(first.body);
  });

  it('validates the selected page and filter, rather than a global category version', async () => {
    const first = await read('/categories?limit=1&page=1').expect(200);
    await read('/categories?limit=1&page=2')
      .set('If-None-Match', first.headers.etag)
      .expect(200);
    await read('/categories?isActive=true')
      .set('If-None-Match', first.headers.etag)
      .expect(200);
    await request(app.getHttpServer())
      .patch('/categories/1')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ description: 'Changed outside page 1' })
      .expect(200);
    await read('/categories?limit=1&page=1')
      .set('If-None-Match', first.headers.etag)
      .expect(304);
  });

  it('requires a valid JWT before evaluating the conditional response', async () => {
    await request(app.getHttpServer())
      .get('/categories')
      .set('If-None-Match', '*')
      .expect(401);
    await request(app.getHttpServer())
      .get('/categories')
      .set('Authorization', 'Bearer invalid')
      .set('If-None-Match', '*')
      .expect(401);
    expect(repository.findAndCount).not.toHaveBeenCalled();
  });

  it('keeps category writes restricted to RESPONSIBLE users', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ name: 'Forbidden' })
      .expect(403);
    await request(app.getHttpServer())
      .patch('/categories/1')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ name: 'Forbidden' })
      .expect(403);
    await request(app.getHttpServer())
      .delete('/categories/1')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(403);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('keeps invalid query responses as errors, not 304', async () => {
    await read('/categories?page=0').set('If-None-Match', '*').expect(400);
    expect(repository.findAndCount).not.toHaveBeenCalled();
  });

  it('does not apply the list cache policy to the category-detail route', async () => {
    const detail = await read('/categories/1').expect(200);
    expect(detail.headers['cache-control']).toBeUndefined();
  });
});
