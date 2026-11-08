/**
 * grpcurl stand-in and manual smoke test.
 *
 * grpcurl is not installed on this machine and has no npm distribution, so
 * this script performs the same checks over the wire with @grpc/grpc-js and
 * @grpc/proto-loader:
 *
 *   list     the server reflection stream, equivalent to `grpcurl list`
 *   health   grpc.health.v1.Health/Check, expecting SERVING
 *   rpcs     the three inventory RPCs, covering success, idempotency,
 *            shortages, the tombstone and every error code
 *
 * It expects the seeded rows to be present (npm run seed) and leaves stock
 * exactly as it found it.
 *
 * Usage: npm run probe -- [host:port]
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { protoPath as healthProtoPath } from 'grpc-health-check';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  resolveInventoryProtoPath,
  resolveProtoDir,
} from '../src/grpc/proto-path';

const ADDRESS = process.argv[2] ?? '127.0.0.1:50051';

const require_ = createRequire(__filename);
const reflectionProtoPath = join(
  dirname(require_.resolve('@grpc/reflection')),
  '..',
  'proto',
  'grpc',
  'reflection',
  'v1',
  'reflection.proto',
);

const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  defaults: true,
  oneofs: true,
  // Render enum values by name, the way grpcurl prints them. Without this the
  // health check reports 1 instead of SERVING. The inventory contract itself
  // declares no enums, so this only affects grpc.health.v1.
  enums: String,
};

let failures = 0;

function check(name: string, pass: boolean, detail: string): void {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} -> ${detail}`);
}

function load(path: string, includeDirs?: string[]): grpc.GrpcObject {
  return grpc.loadPackageDefinition(
    protoLoader.loadSync(path, { ...LOADER_OPTIONS, includeDirs }),
  );
}

type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: number; details: string };

function unary<T>(
  client: grpc.Client,
  method: string,
  payload: unknown,
  deadlineMs = 5000,
): Promise<CallResult<T>> {
  return new Promise((resolve) => {
    const deadline = new Date(Date.now() + deadlineMs);
    (client as unknown as Record<string, Function>)[method](
      payload,
      { deadline },
      (error: grpc.ServiceError | null, value: T) => {
        if (error) {
          resolve({ ok: false, code: error.code ?? -1, details: error.details });
        } else {
          resolve({ ok: true, value });
        }
      },
    );
  });
}

/** Equivalent of `grpcurl -plaintext <addr> list`. */
function listServices(address: string): Promise<string[]> {
  const pkg = load(reflectionProtoPath) as unknown as {
    grpc: {
      reflection: { v1: { ServerReflection: grpc.ServiceClientConstructor } };
    };
  };
  const client = new pkg.grpc.reflection.v1.ServerReflection(
    address,
    grpc.credentials.createInsecure(),
  );

  return new Promise((resolve, reject) => {
    const call = (
      client as unknown as {
        serverReflectionInfo: () => grpc.ClientDuplexStream<unknown, unknown>;
      }
    ).serverReflectionInfo();

    call.on(
      'data',
      (response: { listServicesResponse?: { service: { name: string }[] } }) => {
        const services = response.listServicesResponse?.service ?? [];
        resolve(services.map((entry) => entry.name).sort());
        call.end();
        client.close();
      },
    );
    call.on('error', (error: Error) => {
      client.close();
      reject(error);
    });

    call.write({ listServices: '' });
  });
}

async function main(): Promise<void> {
  console.log(`\n=== reflection: list services on ${ADDRESS} ===`);
  const services = await listServices(ADDRESS);
  for (const service of services) console.log(`  ${service}`);
  check(
    'inventory.v1.InventoryService is advertised',
    services.includes('inventory.v1.InventoryService'),
    services.join(', ') || '(none)',
  );
  check(
    'grpc.health.v1.Health is advertised',
    services.includes('grpc.health.v1.Health'),
    services.includes('grpc.health.v1.Health') ? 'present' : 'missing',
  );

  console.log('\n=== health check ===');
  const healthPkg = load(healthProtoPath) as unknown as {
    grpc: { health: { v1: { Health: grpc.ServiceClientConstructor } } };
  };
  const healthClient = new healthPkg.grpc.health.v1.Health(
    ADDRESS,
    grpc.credentials.createInsecure(),
  );
  for (const service of ['', 'inventory.v1.InventoryService']) {
    const result = await unary<{ status: string }>(healthClient, 'Check', {
      service,
    });
    check(
      `health of "${service || '(overall)'}" is SERVING`,
      result.ok && result.value.status === 'SERVING',
      result.ok ? result.value.status : `code=${result.code} ${result.details}`,
    );
  }
  healthClient.close();

  console.log('\n=== inventory RPCs ===');
  const inventoryPkg = load(resolveInventoryProtoPath(), [
    resolveProtoDir(),
  ]) as unknown as {
    inventory: { v1: { InventoryService: grpc.ServiceClientConstructor } };
  };
  const client = new inventoryPkg.inventory.v1.InventoryService(
    ADDRESS,
    grpc.credentials.createInsecure(),
  );

  const expectCode = async (
    name: string,
    method: string,
    payload: unknown,
    expected: grpc.status,
  ): Promise<void> => {
    const result = await unary(client, method, payload);
    check(
      name,
      !result.ok && result.code === expected,
      result.ok
        ? `unexpected success ${JSON.stringify(result.value)}`
        : `code=${result.code} (${grpc.status[result.code]}) "${result.details}"`,
    );
  };

  const expectOk = async <T>(
    name: string,
    method: string,
    payload: unknown,
    predicate: (value: T) => boolean,
  ): Promise<void> => {
    const result = await unary<T>(client, method, payload);
    check(
      name,
      result.ok && predicate(result.value),
      result.ok
        ? JSON.stringify(result.value)
        : `code=${result.code} (${grpc.status[result.code]}) "${result.details}"`,
    );
  };

  const run = Date.now();
  const id = (suffix: string): string => `probe-${run}-${suffix}`;

  // --- reads -------------------------------------------------------------
  await expectOk<{ items: { productId: string }[] }>(
    'GetStock returns seeded rows and omits unknown ids',
    'GetStock',
    { productIds: ['2', '3', 'no-such-product'] },
    (value) =>
      value.items.length === 2 &&
      value.items.every((item) => item.productId !== 'no-such-product'),
  );

  await expectOk<{ items: unknown[] }>(
    'GetStock with an empty list returns an empty list',
    'GetStock',
    { productIds: [] },
    (value) => value.items.length === 0,
  );

  // --- reserve, idempotency, release -------------------------------------
  const reservationId = id('reserve');
  await expectOk<{ reserved: boolean; shortages: unknown[] }>(
    'ReserveStock succeeds when stock is sufficient',
    'ReserveStock',
    { reservationId, items: [{ productId: '5', quantity: 2 }] },
    (value) => value.reserved === true && value.shortages.length === 0,
  );

  await expectOk<{ reserved: boolean }>(
    'the same reservation id is idempotent',
    'ReserveStock',
    { reservationId, items: [{ productId: '5', quantity: 2 }] },
    (value) => value.reserved === true,
  );

  await expectOk<{ items: { available: number; reserved: number }[] }>(
    'stock moved from available to reserved exactly once',
    'GetStock',
    { productIds: ['5'] },
    (value) => value.items[0].available === 48 && value.items[0].reserved === 2,
  );

  await expectOk<{ released: boolean }>(
    'ReleaseStock gives the units back',
    'ReleaseStock',
    { reservationId },
    (value) => value.released === true,
  );

  await expectOk<{ items: { available: number; reserved: number }[] }>(
    'stock is restored after the release',
    'GetStock',
    { productIds: ['5'] },
    (value) => value.items[0].available === 50 && value.items[0].reserved === 0,
  );

  await expectOk<{ released: boolean }>(
    'releasing twice is idempotent',
    'ReleaseStock',
    { reservationId },
    (value) => value.released === true,
  );

  await expectCode(
    'reserving a released id is refused',
    'ReserveStock',
    { reservationId, items: [{ productId: '5', quantity: 1 }] },
    grpc.status.FAILED_PRECONDITION,
  );

  // --- shortages ---------------------------------------------------------
  await expectOk<{ reserved: boolean; shortages: { productId: string }[] }>(
    'a shortage is a response, not an error',
    'ReserveStock',
    { reservationId: id('short'), items: [{ productId: '7', quantity: 1 }] },
    (value) =>
      value.reserved === false &&
      value.shortages.length === 1 &&
      value.shortages[0].productId === '7',
  );

  await expectOk<{ reserved: boolean; shortages: { productId: string }[] }>(
    'all-or-nothing: one short item blocks the whole order',
    'ReserveStock',
    {
      reservationId: id('mixed'),
      items: [
        { productId: '6', quantity: 1 },
        { productId: '7', quantity: 1 },
      ],
    },
    (value) =>
      value.reserved === false &&
      value.shortages.length === 1 &&
      value.shortages[0].productId === '7',
  );

  await expectOk<{ items: { available: number; reserved: number }[] }>(
    'the sufficient item was rolled back',
    'GetStock',
    { productIds: ['6'] },
    (value) => value.items[0].available === 100 && value.items[0].reserved === 0,
  );

  // --- tombstone ---------------------------------------------------------
  const tombstoneId = id('tombstone');
  await expectOk<{ released: boolean }>(
    'releasing an unknown id reports released=false',
    'ReleaseStock',
    { reservationId: tombstoneId },
    (value) => value.released === false,
  );

  await expectCode(
    'a late reserve on that id is refused by the tombstone',
    'ReserveStock',
    { reservationId: tombstoneId, items: [{ productId: '5', quantity: 1 }] },
    grpc.status.FAILED_PRECONDITION,
  );

  // --- errors ------------------------------------------------------------
  await expectCode(
    'an unknown product is NOT_FOUND',
    'ReserveStock',
    {
      reservationId: id('unknown'),
      items: [{ productId: 'nope', quantity: 1 }],
    },
    grpc.status.NOT_FOUND,
  );

  await expectCode(
    'the same product twice is INVALID_ARGUMENT',
    'ReserveStock',
    {
      reservationId: id('dup'),
      items: [
        { productId: '5', quantity: 1 },
        { productId: '5', quantity: 1 },
      ],
    },
    grpc.status.INVALID_ARGUMENT,
  );

  await expectCode(
    'empty items is rejected by validation',
    'ReserveStock',
    { reservationId: id('empty'), items: [] },
    grpc.status.INVALID_ARGUMENT,
  );

  await expectCode(
    'missing reservationId is rejected by validation',
    'ReserveStock',
    { reservationId: '', items: [{ productId: '5', quantity: 1 }] },
    grpc.status.INVALID_ARGUMENT,
  );

  await expectCode(
    'zero quantity is rejected by validation',
    'ReserveStock',
    { reservationId: id('zero'), items: [{ productId: '5', quantity: 0 }] },
    grpc.status.INVALID_ARGUMENT,
  );

  client.close();

  console.log(
    `\n================  ${
      failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`
    }  ================\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error('PROBE FAILED:', error);
  process.exit(1);
});
