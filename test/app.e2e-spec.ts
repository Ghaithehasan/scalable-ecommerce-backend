import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { QueryFailedError } from 'typeorm';
import { UserEntity } from '../src/users/entities/user.entity';
import { UserGender } from '../src/users/enums/gender.enum';
import { UserRole } from '../src/users/enums/user-role.enum';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';

describe('Users HTTP API (mocked repository)', () => {
  let app: INestApplication<App>;
  let usersService: UsersService;
  let repository: {
    find: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  const createUserBody = {
    name: 'New User',
    email: 'new.user@example.com',
    gender: UserGender.FEMALE,
    password: 'TestPassword123!',
  };

  beforeEach(async () => {
    const existingUser = Object.assign(new UserEntity(), {
      id: 1,
      name: 'Existing User',
      email: 'existing@example.com',
      phone: null,
      gender: UserGender.MALE,
      role: UserRole.CUSTOMER,
      passwordHash: 'a-hash-that-must-never-reach-the-client',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    repository = {
      find: jest.fn().mockResolvedValue([existingUser]),
      findOneBy: jest
        .fn()
        .mockImplementation(async (where: { id?: number; email?: string }) =>
          where.id === existingUser.id || where.email === existingUser.email
            ? existingUser
            : null,
        ),
      create: jest
        .fn()
        .mockImplementation((data: Partial<UserEntity>) =>
          Object.assign(new UserEntity(), data),
        ),
      save: jest.fn().mockImplementation(async (user: UserEntity) =>
        Object.assign(user, {
          id: 2,
          phone: user.phone ?? null,
          role: UserRole.CUSTOMER,
          createdAt: new Date('2026-01-02T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ),
    };
    const moduleFixture = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: repository },
      ],
    }).compile();

    usersService = moduleFixture.get(UsersService);
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  it('returns 404 for a missing user', async () => {
    await request(app.getHttpServer()).get('/users/999').expect(404);
  });

  it('allows internal lookups to return null without throwing', async () => {
    await expect(usersService.findById(999)).resolves.toBeNull();
    await expect(
      usersService.findByEmail('missing@example.com'),
    ).resolves.toBeNull();
  });

  it('rejects a non-numeric user id', async () => {
    await request(app.getHttpServer()).get('/users/invalid').expect(400);
  });

  it('returns only public fields when reading a user', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/1')
      .expect(200);

    expect(response.body).toMatchObject({ id: 1, phone: null });
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('excludes hashes from the user list', async () => {
    const response = await request(app.getHttpServer())
      .get('/users')
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0]).not.toHaveProperty('passwordHash');
  });

  it('hashes the password and excludes credentials from the create response', async () => {
    const response = await request(app.getHttpServer())
      .post('/users')
      .send(createUserBody)
      .expect(201);

    expect(response.body).toMatchObject({
      email: createUserBody.email,
      role: UserRole.CUSTOMER,
      phone: null,
    });
    expect(response.body).not.toHaveProperty('password');
    expect(response.body).not.toHaveProperty('passwordHash');
    const savedUser = repository.save.mock.calls[0][0] as UserEntity;
    await expect(
      bcrypt.compare(createUserBody.password, savedUser.passwordHash),
    ).resolves.toBe(true);
  });

  it('returns 409 for an email that already exists', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ ...createUserBody, email: 'existing@example.com' })
      .expect(409);
  });

  it('returns 409 when a unique constraint fails after the initial lookup', async () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });
    repository.save.mockRejectedValueOnce(
      new QueryFailedError('INSERT INTO users', [], driverError),
    );

    await request(app.getHttpServer())
      .post('/users')
      .send(createUserBody)
      .expect(409);
  });

  it('does not disguise unexpected database errors as conflicts', async () => {
    const databaseError = new QueryFailedError(
      'INSERT INTO users',
      [],
      Object.assign(new Error('database unavailable'), { code: '08006' }),
    );
    repository.save.mockRejectedValueOnce(databaseError);

    await expect(usersService.createUser(createUserBody)).rejects.toBe(
      databaseError,
    );
  });

  it('rejects client-supplied roles', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ ...createUserBody, role: UserRole.RESPONSIBLE })
      .expect(400);
  });

  it.each(['a'.repeat(73), 'س'.repeat(37)])(
    'rejects passwords exceeding the bcrypt byte limit',
    async (password) => {
      await request(app.getHttpServer())
        .post('/users')
        .send({ ...createUserBody, password })
        .expect(400);
    },
  );

  it('rejects an invalid email', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ ...createUserBody, email: 'invalid-email' })
      .expect(400);
  });

  afterEach(async () => {
    await app?.close();
  });
});
