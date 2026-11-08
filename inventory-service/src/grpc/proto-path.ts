import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Path of the contract file inside the shared proto directory. */
export const INVENTORY_PROTO_RELATIVE = join(
  'inventory',
  'v1',
  'inventory.proto',
);

/**
 * Finds the shared `proto/` directory.
 *
 * `proto/` lives at the repository root and is deliberately NOT copied into
 * this package, because the main application has to compile against the very
 * same file. That means its location relative to the compiled output differs
 * between environments, so the candidates below are tried in order and the
 * first one that actually contains the contract wins:
 *
 *   PROTO_DIR            explicit override (the Docker image sets it)
 *   ../../../proto       running from inventory-service/dist/grpc
 *                        or from inventory-service/src/grpc under ts-node
 *   ../../proto          running from /app/dist/grpc inside the image, where
 *                        proto/ and dist/ are siblings under /app
 *   <cwd>/../proto       running with inventory-service/ as the cwd
 *
 * Failing loudly with the list of attempted paths is far easier to debug than
 * the "namespace not found" error proto-loader raises for a missing file.
 */
export function resolveProtoDir(): string {
  const candidates = [
    process.env.PROTO_DIR,
    resolve(__dirname, '..', '..', '..', 'proto'),
    resolve(__dirname, '..', '..', 'proto'),
    resolve(process.cwd(), '..', 'proto'),
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

/** Absolute path of the inventory contract file. */
export function resolveInventoryProtoPath(): string {
  return join(resolveProtoDir(), INVENTORY_PROTO_RELATIVE);
}
