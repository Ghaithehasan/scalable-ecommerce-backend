/**
 * End-to-end proof of requirement 2, driven entirely through the public HTTP
 * API of the main application.
 *
 * Nothing here talks to the inventory service directly: the point is to show
 * what a CUSTOMER experiences, with the gRPC call happening inside the order
 * flow where it belongs.
 *
 *   1. product details carry the quantity the warehouse holds
 *   2. a normal order reserves stock and the quantity drops
 *   3. not enough stock -> 409 naming every short item, no order created
 *   4. the race: N simultaneous orders for the last unit -> exactly one wins
 *   5. the warehouse is stopped -> 503 with a clear message, no order created
 *
 * The script aligns the warehouse to whatever product ids the catalogue
 * actually holds, which is the same thing you do in real life: the inventory
 * service keys its rows by the catalogue's product id, as a string.
 *
 * Steps 4 and 5 drive the containers, so Docker must be running.
 *
 *   npm run demo:req2              20 simultaneous buyers
 *   npm run demo:req2 -- 50        50
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const BUYERS = Number(process.argv[2] ?? 20);
const STAMP = Date.now();
const PLENTY = 500;

let failures = 0;

function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`,
  );
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

interface Res<T> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Res<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

function docker(...args: string[]): void {
  execFileSync('docker', args, { stdio: 'ignore' });
}

/** Writes stock rows straight into the warehouse's own database. */
function setWarehouseStock(rows: { productId: number; available: number }[]): void {
  const values = rows
    .map((row) => `('${row.productId}', ${row.available}, 0)`)
    .join(', ');

  docker(
    'compose', '-f', 'inventory-service/docker-compose.yml',
    'exec', '-T', 'inventory-postgres',
    'psql', '-U', 'postgres', '-d', 'inventory', '-c',
    `INSERT INTO stock (product_id, available, reserved) VALUES ${values}
     ON CONFLICT (product_id)
     DO UPDATE SET available = EXCLUDED.available, reserved = 0, updated_at = now()`,
  );
}

const tokens = { customer: '', manager: '' };

async function waitForInventory(expectUp: boolean, productId: number): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const probe = await call<any>(`GET`, `/products/${productId}`, {
      token: tokens.manager,
    });
    const reachable = probe.status === 200 && probe.body?.stock !== null;
    if (reachable === expectUp) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `inventory did not become ${expectUp ? 'reachable' : 'unreachable'} in time`,
  );
}

async function register(label: string): Promise<{ email: string; token: string }> {
  const email = `req2.${label}.${STAMP}@example.com`;
  const res = await call<any>('POST', '/auth/register', {
    body: {
      name: `Req2 ${label}`,
      email,
      gender: 'MALE',
      password: 'Requirement2Pass!',
    },
  });
  if (res.status !== 201) {
    throw new Error(
      `register ${label} -> ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return { email, token: res.body.accessToken };
}

async function main(): Promise<void> {
  heading('SETUP');

  const customer = await register('customer');
  const manager = await register('manager');
  tokens.customer = customer.token;
  tokens.manager = manager.token;

  // Roles are read from the database on every request, so the token issued a
  // moment ago immediately carries the new role.
  docker(
    'compose', '-f', 'docker-compose.yml', 'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'internet_app', '-c',
    `UPDATE users SET role = 'RESPONSIBLE' WHERE email = '${manager.email}'`,
  );

  const me = await call<any>('GET', '/auth/me', { token: tokens.manager });
  check('manager account is RESPONSIBLE', me.body?.role === 'RESPONSIBLE', me.body?.role);

  // Make sure the catalogue has at least two products to work with.
  let page = await call<any>('GET', '/products?limit=100', { token: tokens.manager });
  if ((page.body?.data ?? []).length < 2) {
    const category = await call<any>('POST', '/categories', {
      token: tokens.manager,
      body: { name: `Req2 Category ${STAMP}` },
    });
    for (let i = (page.body?.data ?? []).length; i < 2; i += 1) {
      await call('POST', '/products', {
        token: tokens.manager,
        body: {
          name: `Demo product ${STAMP}-${i}`,
          price: 100 + i,
          categoryId: category.body.id,
        },
      });
    }
    page = await call<any>('GET', '/products?limit=100', { token: tokens.manager });
  }

  const catalogue: { id: number; name: string }[] = page.body.data;
  const plentyId = catalogue[0].id;
  const lastUnitId = catalogue[1].id;

  console.log(`  catalogue products : ${catalogue.map((p) => p.id).join(', ')}`);
  console.log(`  "plenty" product   : ${plentyId}`);
  console.log(`  "last unit" product: ${lastUnitId}`);

  // The warehouse keys its rows by the catalogue id, as a string. Aligning
  // them here is exactly the mapping the README documents.
  setWarehouseStock([
    { productId: plentyId, available: PLENTY },
    { productId: lastUnitId, available: 1 },
  ]);
  check('warehouse stock aligned to the catalogue ids', true);

  heading('1. PRODUCT DETAILS CARRY THE WAREHOUSE QUANTITY');

  const detail = await call<any>('GET', `/products/${plentyId}`, { token: tokens.customer });
  check('GET /products/:id returns 200', detail.status === 200, String(detail.status));
  check(
    'the response includes a stock block from the inventory service',
    detail.body?.stock !== null && typeof detail.body?.stock?.available === 'number',
    JSON.stringify(detail.body?.stock),
  );

  const listed = await call<any>('GET', '/products?limit=5', { token: tokens.customer });
  check(
    'the product list carries stock too (one batch gRPC call per page)',
    (listed.body?.data ?? []).every((p: any) => 'stock' in p),
    `${listed.body?.data?.length ?? 0} products`,
  );

  heading('2. A NORMAL ORDER RESERVES STOCK');

  const before = (await call<any>('GET', `/products/${plentyId}`, { token: tokens.customer })).body.stock;
  const order = await call<any>('POST', '/orders', {
    token: tokens.customer,
    body: { items: [{ productId: plentyId, quantity: 2 }] },
  });
  check('order accepted (201)', order.status === 201, JSON.stringify(order.body).slice(0, 120));

  const after = (await call<any>('GET', `/products/${plentyId}`, { token: tokens.customer })).body.stock;
  check(
    'available dropped by 2 and reserved rose by 2',
    after.available === before.available - 2 && after.reserved === before.reserved + 2,
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );

  heading('3. NOT ENOUGH STOCK -> 409 WITH THE SHORTAGES');

  const ordersBefore = (await call<any>('GET', '/orders?limit=100', { token: tokens.customer })).body.meta.total;

  // Just over what the warehouse holds, but still within the per-line limit
  // requirement 1 enforces (max 1000). Asking for more than that is rejected
  // with 400 by local validation before any gRPC call is made - which is the
  // right order, but it would not exercise the warehouse.
  const availableNow = (
    await call<any>('GET', `/products/${plentyId}`, { token: tokens.customer })
  ).body.stock.available;
  const tooMany = Math.min(1000, availableNow + 1);

  const greedy = await call<any>('POST', '/orders', {
    token: tokens.customer,
    body: { items: [{ productId: plentyId, quantity: tooMany }] },
  });
  console.log(`  warehouse holds ${availableNow}, the basket asks for ${tooMany}`);
  check('order refused with 409', greedy.status === 409, String(greedy.status));
  check(
    'the body names the short product, what was asked and what is left',
    Array.isArray(greedy.body?.shortages) && greedy.body.shortages.length > 0,
    JSON.stringify(greedy.body?.shortages),
  );

  const ordersAfter = (await call<any>('GET', '/orders?limit=100', { token: tokens.customer })).body.meta.total;
  check('no order was created for the refused basket', ordersAfter === ordersBefore, `${ordersBefore} -> ${ordersAfter}`);

  heading(`4. THE RACE: ${BUYERS} SIMULTANEOUS ORDERS FOR THE LAST UNIT`);

  setWarehouseStock([{ productId: lastUnitId, available: 1 }]);

  const stockBefore = (await call<any>('GET', `/products/${lastUnitId}`, { token: tokens.customer })).body.stock;
  console.log(`\n  product      : ${lastUnitId}`);
  console.log(`  stock before : ${JSON.stringify(stockBefore)}`);
  console.log(`  buyers       : ${BUYERS} simultaneous POST /orders\n`);

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: BUYERS }, () =>
      call<any>('POST', '/orders', {
        token: tokens.customer,
        body: { items: [{ productId: lastUnitId, quantity: 1 }] },
      }),
    ),
  );
  const elapsedMs = Date.now() - startedAt;

  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  console.log(`  201 Created  : ${created.length}`);
  console.log(`  409 Conflict : ${refused.length}`);
  console.log(
    `  anything else: ${other.length}${other.length ? ' -> ' + JSON.stringify(other.map((r) => r.status)) : ''}`,
  );
  console.log(`  elapsed      : ${elapsedMs} ms\n`);

  check('exactly one buyer got the last unit', created.length === 1, `${created.length} created`);
  check('every other buyer got a clean 409', refused.length === BUYERS - 1, `${refused.length} refused`);
  check('no request produced an unexpected status', other.length === 0);

  const stockAfter = (await call<any>('GET', `/products/${lastUnitId}`, { token: tokens.customer })).body.stock;
  check(
    'the ledger balances: available 0, reserved 1',
    stockAfter.available === 0 && stockAfter.reserved === 1,
    JSON.stringify(stockAfter),
  );

  heading('5. THE INVENTORY SERVICE IS STOPPED');

  console.log('  stopping the inventory container...');
  docker('compose', '-f', 'inventory-service/docker-compose.yml', 'stop', 'inventory');
  await waitForInventory(false, plentyId);

  const whileDown = await call<any>('POST', '/orders', {
    token: tokens.customer,
    body: { items: [{ productId: plentyId, quantity: 1 }] },
  });

  console.log('\n  what the customer sees:');
  console.log(`    HTTP ${whileDown.status}`);
  console.log(
    `    ${JSON.stringify(whileDown.body, null, 2).split('\n').join('\n    ')}\n`,
  );

  check('the customer gets 503, not a hang and not a stack trace', whileDown.status === 503, String(whileDown.status));
  check(
    'the message says plainly that the order was not placed',
    /not placed/i.test(String(whileDown.body?.message)),
    String(whileDown.body?.message),
  );

  const catalogueWhileDown = await call<any>('GET', `/products/${plentyId}`, { token: tokens.customer });
  check(
    'the catalogue still works, with stock reported as null',
    catalogueWhileDown.status === 200 && catalogueWhileDown.body.stock === null,
    `HTTP ${catalogueWhileDown.status}, stock=${JSON.stringify(catalogueWhileDown.body.stock)}`,
  );

  console.log('  restarting the inventory container...');
  docker('compose', '-f', 'inventory-service/docker-compose.yml', 'start', 'inventory');
  await waitForInventory(true, plentyId);

  const recovered = await call<any>('POST', '/orders', {
    token: tokens.customer,
    body: { items: [{ productId: plentyId, quantity: 1 }] },
  });
  check('orders work again once the warehouse is back', recovered.status === 201, String(recovered.status));

  heading(failures === 0 ? 'ALL REQUIREMENT 2 CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error);
  process.exit(1);
});
