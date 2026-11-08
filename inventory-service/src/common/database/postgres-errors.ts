/** PostgreSQL SQLSTATE codes this service reacts to. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  // TypeORM's QueryFailedError copies the driver error's own properties onto
  // itself, so the code is readable from either object.
  const candidates = [error, (error as { driverError?: unknown }).driverError];

  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'code' in candidate &&
      typeof (candidate as { code: unknown }).code === 'string'
    ) {
      return (candidate as { code: string }).code;
    }
  }

  return undefined;
}

/** A unique index rejected the row (two callers used one reservation id). */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/**
 * A CHECK constraint rejected the row. In this service that means stock was
 * about to go negative, which is a bug in the application logic rather than
 * anything the caller did.
 */
export function isCheckViolation(error: unknown): boolean {
  return sqlStateOf(error) === CHECK_VIOLATION;
}

/**
 * Reads the rows returned by an `UPDATE ... RETURNING` run through
 * `EntityManager.query`.
 *
 * Verified against typeorm 1.1.2: that call resolves to the tuple
 * `[rows, affectedCount]`, NOT to a bare rows array as in 0.3.x. Reading
 * `result.length` would therefore be 2 for every statement, including one
 * that matched nothing - which, for the conditional reserve below, would turn
 * every refused reservation into a successful one and oversell the warehouse.
 * Both shapes are handled so an upgrade cannot reintroduce that silently.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }

  return Array.isArray(result) ? (result as T[]) : [];
}
