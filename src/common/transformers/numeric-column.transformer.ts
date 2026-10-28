import type { ValueTransformer } from 'typeorm';

/**
 * The PostgreSQL driver returns `numeric`/`decimal` columns as strings so that
 * large values keep their precision. Monetary columns in this project stay
 * within DECIMAL(10,2), which JavaScript numbers represent exactly, so they are
 * converted on read to keep arithmetic and JSON responses numeric.
 */
export const numericColumnTransformer: ValueTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};
