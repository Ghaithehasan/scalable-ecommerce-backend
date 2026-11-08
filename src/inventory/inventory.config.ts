import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where the shared contract lives, and how long we are willing to wait for the
 * warehouse.
 */

export const INVENTORY_PROTO_RELATIVE = join(
  'inventory',
  'v1',
  'inventory.proto',
);

/**
 * The contract is at the repository root, shared with the inventory service.
 * Its position relative to the compiled output differs between a local run
 * (dist/inventory -> repo root) and the Docker image (/app/dist/inventory ->
 * /app), so the candidates are tried in order and the first one that actually
 * holds the file wins.
 */
export function resolveProtoDir(): string {
  const candidates = [
    process.env.PROTO_DIR,
    resolve(__dirname, '..', '..', 'proto'),
    resolve(__dirname, '..', '..', '..', 'proto'),
    resolve(process.cwd(), 'proto'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, INVENTORY_PROTO_RELATIVE))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find ${INVENTORY_PROTO_RELATIVE}. Tried: ${candidates.join(', ')}. ` +
      'Set PROTO_DIR to the repository\'s proto directory.',
  );
}

export function resolveInventoryProtoPath(): string {
  return join(resolveProtoDir(), INVENTORY_PROTO_RELATIVE);
}

/** Address of the inventory gRPC server. */
export function inventoryGrpcUrl(): string {
  return process.env.INVENTORY_GRPC_URL ?? 'localhost:50051';
}

/**
 * Every call carries a deadline. Without one a wedged warehouse would leave
 * the customer's HTTP request hanging until the browser gives up, which is
 * precisely the failure the requirement asks us to handle.
 *
 * Reserving is given more room than reading because it writes.
 */
export function reserveTimeoutMs(): number {
  return Number(process.env.INVENTORY_RESERVE_TIMEOUT_MS ?? 3000);
}

export function readTimeoutMs(): number {
  return Number(process.env.INVENTORY_READ_TIMEOUT_MS ?? 1500);
}

/**
 * Releasing is compensation: it runs after something already went wrong, so it
 * gets its own, slightly longer budget rather than inheriting a deadline that
 * may already have expired.
 */
export function releaseTimeoutMs(): number {
  return Number(process.env.INVENTORY_RELEASE_TIMEOUT_MS ?? 5000);
}
