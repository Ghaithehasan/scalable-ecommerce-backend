import { plainToInstance, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/**
 * Every environment variable the service reads, with its default and its
 * constraints. The process refuses to start when any of them is missing or
 * malformed, so a misconfigured deployment fails immediately and loudly
 * instead of failing later on the first database call.
 */
export class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  GRPC_HOST: string = '0.0.0.0';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  GRPC_PORT: number = 50051;

  @IsString()
  @IsNotEmpty()
  DB_HOST: string = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT: number = 5434;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME: string = 'postgres';

  // An empty password is valid (trust authentication in local development).
  @IsString()
  DB_PASSWORD: string = '';

  @IsString()
  @IsNotEmpty()
  DB_DATABASE: string = 'inventory';

  /** PostgreSQL aborts any statement that runs longer than this. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600000)
  DB_STATEMENT_TIMEOUT_MS: number = 5000;

  /**
   * Demonstration switch only. When > 0, ReserveStock sleeps this long before
   * it does any work, so a client with a shorter deadline can be shown
   * receiving DEADLINE_EXCEEDED. Must be 0 outside the demo.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600000)
  INVENTORY_ARTIFICIAL_DELAY_MS: number = 0;

  @IsString()
  @IsNotEmpty()
  LOG_LEVELS: string = 'error,warn,log';
}

/**
 * Validates the raw environment. Passed to ConfigModule as its `validate`
 * hook, and called directly in main.ts because the gRPC transport options are
 * needed before the Nest container exists.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const parsed = plainToInstance(EnvironmentVariables, raw, {
    // Class property initialisers are the single source of defaults; without
    // this flag an absent variable would stay undefined and fail validation.
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(parsed, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return parsed;
}
