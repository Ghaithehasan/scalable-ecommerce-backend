import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';

import { RolesGuard } from '../src/auth/guards/roles.guard';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { UserResponseDto } from '../src/users/dto/user-response.dto';
import { UserGender } from '../src/users/enums/gender.enum';
import { UserRole } from '../src/users/enums/user-role.enum';

/**
 * Shared test setup.
 *
 * The suites below mock the repositories and replace only the JWT guard, so the
 * real RolesGuard, ValidationPipe, exception filter, controllers and services
 * all run exactly as they do in the application.
 */

function makeUser(
  id: number,
  name: string,
  email: string,
  gender: UserGender,
  role: UserRole,
): UserResponseDto {
  return {
    id,
    name,
    email,
    phone: null,
    gender,
    role,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

export const CUSTOMER = makeUser(
  10,
  'Customer One',
  'customer.one@example.com',
  UserGender.FEMALE,
  UserRole.CUSTOMER,
);

export const OTHER_CUSTOMER = makeUser(
  11,
  'Customer Two',
  'customer.two@example.com',
  UserGender.FEMALE,
  UserRole.CUSTOMER,
);

export const RESPONSIBLE = makeUser(
  1,
  'Shop Manager',
  'manager@example.com',
  UserGender.MALE,
  UserRole.RESPONSIBLE,
);

/** Stands in for JwtAuthGuard: authenticates every request as `actingUser`. */
class StubAuthGuard implements CanActivate {
  constructor(private readonly session: { user: UserResponseDto }) {}

  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user: UserResponseDto }>().user =
      this.session.user;
    return true;
  }
}

export interface Harness {
  app: INestApplication<App>;
  /** Changes who the next request is authenticated as. */
  actAs(user: UserResponseDto): void;
}

export async function createHarness(options: {
  controllers: unknown[];
  providers: unknown[];
}): Promise<Harness> {
  const session = { user: CUSTOMER };

  const moduleFixture = await Test.createTestingModule({
    controllers: options.controllers as never[],
    providers: [
      ...(options.providers as never[]),
      { provide: APP_GUARD, useValue: new StubAuthGuard(session) },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  }).compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return {
    app,
    actAs(user: UserResponseDto): void {
      session.user = user;
    },
  };
}
