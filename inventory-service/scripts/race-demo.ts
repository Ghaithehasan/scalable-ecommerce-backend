/**
 * Live demonstration of the race condition, for the defence.
 *
 * Resets one product to a single unit, fires N simultaneous ReserveStock
 * calls for it, and prints what happened. Exactly one caller may win.
 *
 * It uses a plain @grpc/grpc-js client over the shared contract - no test
 * runner, no extra tooling - so it can be pointed at any running instance,
 * including the one inside Docker.
 *
 *   npm run demo:race                      20 callers, 127.0.0.1:50051
 *   npm run demo:race -- 50                50 callers
 *   npm run demo:race -- 50 host:port      against another address
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';

import dataSource from '../src/database/data-source';
import {
  resolveInventoryProtoPath,
  resolveProtoDir,
} from '../src/grpc/proto-path';

const CALLERS = Number(process.argv[2] ?? 20);
const ADDRESS = process.argv[3] ?? '127.0.0.1:50051';
const PRODUCT_ID = process.env.DEMO_PRODUCT_ID ?? '1';

interface ReserveResponse {
  reserved: boolean;
  shortages: { productId: string; requested: number; available: number }[];
}

interface StockRow {
  available: number;
  reserved: number;
}

type Outcome =
  | { kind: 'granted'; reservationId: string }
  | { kind: 'refused'; available: number }
  | { kind: 'error'; code: number; details: string };

function buildClient(): grpc.Client {
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(resolveInventoryProtoPath(), {
      keepCase: false,
      defaults: true,
      oneofs: true,
      includeDirs: [resolveProtoDir()],
    }),
  ) as unknown as {
    inventory: { v1: { InventoryService: grpc.ServiceClientConstructor } };
  };

  return new pkg.inventory.v1.InventoryService(
    ADDRESS,
    grpc.credentials.createInsecure(),
  );
}

function reserve(client: grpc.Client, reservationId: string): Promise<Outcome> {
  return new Promise((resolve) => {
    (client as unknown as Record<string, Function>).ReserveStock(
      {
        reservationId,
        items: [{ productId: PRODUCT_ID, quantity: 1 }],
      },
      { deadline: new Date(Date.now() + 15000) },
      (error: grpc.ServiceError | null, response: ReserveResponse) => {
        if (error) {
          resolve({
            kind: 'error',
            code: error.code ?? -1,
            details: error.details ?? '',
          });
          return;
        }

        resolve(
          response.reserved
            ? { kind: 'granted', reservationId }
            : {
                kind: 'refused',
                available: response.shortages[0]?.available ?? -1,
              },
        );
      },
    );
  });
}

async function main(): Promise<void> {
  await dataSource.initialize();

  // Start from exactly one unit, and clear any reservation holding it.
  await dataSource.query(
    `INSERT INTO stock (product_id, available, reserved)
     VALUES ($1, 1, 0)
     ON CONFLICT (product_id)
     DO UPDATE SET available = 1, reserved = 0, updated_at = now()`,
    [PRODUCT_ID],
  );

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  RACE DEMONSTRATION: one unit, many simultaneous buyers  │');
  console.log('  └─────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  server      : ${ADDRESS}`);
  console.log(`  product     : "${PRODUCT_ID}"`);
  console.log(`  stock before: available 1, reserved 0`);
  console.log(`  callers     : ${CALLERS} simultaneous ReserveStock calls`);
  console.log('');

  const client = buildClient();
  const startedAt = Date.now();

  // Every caller generates its own reservation id, exactly as the main
  // application will, and they all go out together.
  const outcomes = await Promise.all(
    Array.from({ length: CALLERS }, () => reserve(client, randomUUID())),
  );

  const elapsedMs = Date.now() - startedAt;
  client.close();

  const granted = outcomes.filter((o) => o.kind === 'granted');
  const refused = outcomes.filter((o) => o.kind === 'refused');
  const errored = outcomes.filter((o) => o.kind === 'error');

  const [stock] = (await dataSource.query(
    'SELECT available, reserved FROM stock WHERE product_id = $1',
    [PRODUCT_ID],
  )) as StockRow[];

  console.log('  result');
  console.log('  ────────────────────────────────  ─────');
  console.log(`  reserved = true  (order accepted)  ${granted.length}`);
  console.log(`  reserved = false (out of stock)    ${refused.length}`);
  console.log(`  technical errors                   ${errored.length}`);
  console.log('');
  console.log(`  stock after : available ${stock.available}, reserved ${stock.reserved}`);
  console.log(`  elapsed     : ${elapsedMs} ms`);
  console.log('');

  for (const outcome of granted) {
    if (outcome.kind === 'granted') {
      console.log(`  winner      : ${outcome.reservationId}`);
    }
  }
  for (const outcome of errored) {
    if (outcome.kind === 'error') {
      console.log(
        `  error       : code=${outcome.code} ${grpc.status[outcome.code]} ${outcome.details}`,
      );
    }
  }

  const correct =
    granted.length === 1 &&
    refused.length === CALLERS - 1 &&
    errored.length === 0 &&
    stock.available === 0 &&
    stock.reserved === 1;

  console.log('');
  console.log(
    correct
      ? '  ✓ Exactly one buyer got the last unit. No overselling.'
      : '  ✗ UNEXPECTED RESULT - see the numbers above.',
  );
  console.log('');

  await dataSource.destroy();
  process.exit(correct ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error('RACE DEMO FAILED:', error);
  process.exit(1);
});
