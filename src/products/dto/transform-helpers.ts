import type { TransformFnParams } from 'class-transformer';

/**
 * Query strings carry booleans as text. Unrecognised values are passed through
 * unchanged so `@IsBoolean()` reports them as a validation error instead of
 * being silently read as `false`.
 */
export function toOptionalBoolean({ value }: TransformFnParams): unknown {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (value === 'true' || value === true) {
    return true;
  }

  if (value === 'false' || value === false) {
    return false;
  }

  return value;
}
