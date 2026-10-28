import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE codes used by the integrity checks in this project. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof QueryFailedError)) {
    return undefined;
  }

  const driverError: unknown = error.driverError;

  if (
    typeof driverError === 'object' &&
    driverError !== null &&
    'code' in driverError &&
    typeof driverError.code === 'string'
  ) {
    return driverError.code;
  }

  return undefined;
}

/** A unique index rejected the row (for example a duplicate slug). */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/**
 * A foreign key rejected the statement: either the referenced row is missing,
 * or the row being deleted is still referenced by a child row.
 *
 * PostgreSQL reports these with two different codes. A plain foreign key check
 * raises 23503, while a deletion refused by ON DELETE RESTRICT -- which is how
 * products, categories and order lines are wired -- raises 23001. Both mean the
 * same thing to this API, so both are recognised here.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code === FOREIGN_KEY_VIOLATION || code === RESTRICT_VIOLATION;
}
