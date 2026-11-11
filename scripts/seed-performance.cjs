// Manual synthetic data for read benchmarks. Never called by app startup/migrations.
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const demo = require('./demo-data.json');

const DATASET = 'ecommerce-performance-v1';
const USER_COUNT = 100;
const ORDER_COUNT = 1000;
const ORDER_PREFIX = 'PERF-V1-';
const STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const BASE_TIME = Date.UTC(2025, 0, 1);
const BATCH_SIZE = 200;

const users = Array.from({ length: USER_COUNT }, (_, index) => {
  const manager = index === USER_COUNT - 1;
  const label = String(index + 1).padStart(3, '0');
  return {
    name: manager ? 'Performance Manager' : `Performance Customer ${label}`,
    email: manager
      ? 'perf.v1.manager@example.com'
      : `perf.v1.customer${label}@example.com`,
    gender: index % 2 ? 'FEMALE' : 'MALE',
    role: manager ? 'RESPONSIBLE' : 'CUSTOMER',
  };
});

const categories = demo.categories.map((fixture) => ({
  ...fixture,
  slug: fixture.slug.replace(/^demo-/, 'perf-v1-'),
  name: `Performance ${fixture.name}`,
  description: `${DATASET}: synthetic catalogue for read benchmarks.`,
}));
const products = demo.products.map((fixture) => ({
  name: fixture.name,
  category: fixture.category.replace(/^demo-/, 'perf-v1-'),
  description: `${DATASET}: ${fixture.sku}`,
  cents: Math.round(Number(fixture.price) * 100),
}));

function options(argv) {
  const result = { mode: 'preview', allowRemote: false };
  let explicitMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--preview', '--apply', '--verify'].includes(arg)) {
      if (explicitMode)
        throw new Error('Choose only one of --preview, --apply, --verify');
      result.mode = arg.slice(2);
      explicitMode = true;
    } else if (arg === '--allow-remote' && !result.allowRemote) {
      result.allowRemote = true;
    } else if (
      arg === '--confirm-database' &&
      !result.database &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    ) {
      result.database = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return result;
}

function connectionOptions(env, args) {
  for (const key of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  const port = Number(env.DB_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid DB_PORT');
  if (args.mode === 'apply') {
    if (args.database !== env.DB_DATABASE) {
      throw new Error(
        'Writing requires --confirm-database with the exact DB_DATABASE value',
      );
    }
    if (
      !['localhost', '127.0.0.1', '::1', 'postgres'].includes(env.DB_HOST) &&
      !args.allowRemote
    ) {
      throw new Error(
        'Writing to a remote database requires --allow-remote as well',
      );
    }
  }
  return {
    host: env.DB_HOST,
    port,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    application_name: 'manual-performance-seed-v1',
  };
}

function password(env) {
  const value = env.PERF_SEED_PASSWORD;
  const bytes =
    typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
  if (bytes < 12 || bytes > 72)
    throw new Error('New users require PERF_SEED_PASSWORD: 12-72 UTF-8 bytes');
  return value;
}

function money(cents) {
  return (cents / 100).toFixed(2);
}
function batches(rows) {
  return Array.from(
    { length: Math.ceil(rows.length / BATCH_SIZE) },
    (_, index) => rows.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
  );
}

async function assertSchema(client) {
  const required = {
    users: ['id', 'name', 'email', 'gender', 'role', 'passwordHash'],
    categories: ['id', 'slug', 'name', 'description'],
    products: ['id', 'name', 'description', 'price', 'category_id'],
    orders: [
      'id',
      'order_number',
      'user_id',
      'status',
      'total_amount',
      'inventory_reservation_id',
      'created_at',
    ],
    order_items: ['id', 'order_id', 'product_id', 'quantity', 'unit_price'],
    inventory_order_operations: ['id', 'status'],
  };
  const result = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const actual = new Set(
    result.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  for (const [table, columns] of Object.entries(required)) {
    for (const column of columns) {
      if (!actual.has(`${table}.${column}`))
        throw new Error(
          `Missing Main schema column ${table}.${column}; run the existing Main migrations on the intended database first`,
        );
    }
  }
}

async function readUsers(client) {
  const { rows } = await client.query(
    'SELECT id, name, email, gender, role, "passwordHash" FROM public.users WHERE email = ANY($1::text[])',
    [users.map((row) => row.email)],
  );
  for (const row of rows) {
    const expected = users.find((fixture) => fixture.email === row.email);
    if (
      row.name !== expected.name ||
      row.gender !== expected.gender ||
      row.role !== expected.role
    ) {
      throw new Error(
        `Reserved performance email collision: ${row.email}; account was not modified`,
      );
    }
    if (
      !/^\$2[aby]\$\d\d\$/.test(row.passwordHash) ||
      bcrypt.getRounds(row.passwordHash) < 10
    ) {
      throw new Error(`Unsupported existing password hash for ${row.email}`);
    }
  }
  return new Map(rows.map((row) => [row.email, row]));
}

async function catalogue(client, apply, inserted) {
  const categoryIds = new Map();
  for (const fixture of categories) {
    if (apply) {
      const result = await client.query(
        'INSERT INTO public.categories (name, slug, description, is_active) VALUES ($1, $2, $3, true) ON CONFLICT (slug) DO NOTHING RETURNING id',
        [fixture.name, fixture.slug, fixture.description],
      );
      inserted.categories += result.rowCount;
    }
    const { rows } = await client.query(
      'SELECT id, name, description FROM public.categories WHERE slug = $1',
      [fixture.slug],
    );
    if (
      !rows.length ||
      rows[0].name !== fixture.name ||
      rows[0].description !== fixture.description
    ) {
      throw new Error(
        `Missing or conflicting performance category: ${fixture.slug}`,
      );
    }
    categoryIds.set(fixture.slug, rows[0].id);
  }
  const result = [];
  for (const fixture of products) {
    const categoryId = categoryIds.get(fixture.category);
    let { rows } = await client.query(
      'SELECT id, description FROM public.products WHERE category_id = $1 AND name = $2 ORDER BY id',
      [categoryId, fixture.name],
    );
    if (!rows.length && apply) {
      const saved = await client.query(
        'INSERT INTO public.products (name, description, price, category_id, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id, description',
        [fixture.name, fixture.description, money(fixture.cents), categoryId],
      );
      rows = saved.rows;
      inserted.products += saved.rowCount;
    }
    if (rows.length !== 1 || rows[0].description !== fixture.description) {
      throw new Error(
        `Missing or conflicting performance product: ${fixture.name}`,
      );
    }
    result.push({ ...fixture, id: rows[0].id });
  }
  return result;
}

function orderFixtures(userMap, catalogueRows) {
  const customers = users.filter((row) => row.role === 'CUSTOMER');
  return Array.from({ length: ORDER_COUNT }, (_, index) => {
    const items = Array.from({ length: 1 + (index % 4) }, (_, line) => {
      const product = catalogueRows[(index + line) % catalogueRows.length];
      return {
        product_id: product.id,
        quantity: 1 + ((index + line) % 3),
        cents: product.cents,
      };
    });
    return {
      order_number: ORDER_PREFIX + String(index + 1).padStart(6, '0'),
      user_id: userMap.get(customers[index % customers.length].email).id,
      status: STATUSES[index % STATUSES.length],
      total_amount: money(
        items.reduce((sum, row) => sum + row.cents * row.quantity, 0),
      ),
      created_at: new Date(BASE_TIME + index * 3600000).toISOString(),
      items,
    };
  });
}

async function collect(client) {
  const userMap = await readUsers(client);
  if (userMap.size !== USER_COUNT)
    throw new Error(
      `Missing performance users: found ${userMap.size}/${USER_COUNT}`,
    );
  const catalogueRows = await catalogue(client, false);
  const expected = orderFixtures(userMap, catalogueRows);
  const { rows: orders } = await client.query(
    'SELECT id, order_number, user_id, status, total_amount, inventory_reservation_id FROM public.orders WHERE order_number = ANY($1::text[])',
    [expected.map((row) => row.order_number)],
  );
  if (orders.length !== ORDER_COUNT)
    throw new Error(
      `Missing performance orders: found ${orders.length}/${ORDER_COUNT}`,
    );
  const { rows: items } = await client.query(
    'SELECT order_id, product_id, quantity, unit_price FROM public.order_items WHERE order_id = ANY($1::int[]) ORDER BY product_id',
    [orders.map((row) => row.id)],
  );
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push(item);
  }
  const actualByNumber = new Map(orders.map((row) => [row.order_number, row]));
  const signature = (rows) =>
    rows
      .map(
        (row) =>
          `${row.product_id}:${row.quantity}:${row.cents ?? Math.round(Number(row.unit_price) * 100)}`,
      )
      .sort()
      .join('|');
  for (const fixture of expected) {
    const row = actualByNumber.get(fixture.order_number);
    if (
      row.user_id !== fixture.user_id ||
      row.inventory_reservation_id !== null ||
      money(Math.round(Number(row.total_amount) * 100)) !==
        fixture.total_amount ||
      signature(itemsByOrder.get(row.id) || []) !== signature(fixture.items)
    ) {
      throw new Error(
        `Conflicting performance order/items: ${fixture.order_number}; existing data was not overwritten`,
      );
    }
  }
  return {
    dataset: DATASET,
    totals: {
      users: userMap.size,
      categories: categories.length,
      products: catalogueRows.length,
      orders: orders.length,
      orderItems: items.length,
    },
    statusCounts: Object.fromEntries(
      STATUSES.map((status) => [
        status,
        orders.filter((row) => row.status === status).length,
      ]),
    ),
    accounts: {
      customer: users[0].email,
      manager: users[USER_COUNT - 1].email,
    },
    orderExamples: orders
      .sort((a, b) => a.order_number.localeCompare(b.order_number))
      .slice(0, 3),
  };
}

async function seedPerformance(client, env = process.env) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      DATASET,
    ]);
    await assertSchema(client);
    const inserted = {
      users: 0,
      categories: 0,
      products: 0,
      orders: 0,
      orderItems: 0,
    };
    const existing = await readUsers(client);
    const missing = users.filter((row) => !existing.has(row.email));
    if (missing.length) {
      const plaintext = password(env);
      const newUsers = [];
      // Distinct bcrypt salts per account, with bounded CPU concurrency.
      for (let index = 0; index < missing.length; index += 4) {
        newUsers.push(
          ...(await Promise.all(
            missing
              .slice(index, index + 4)
              .map(async (row) => ({
                ...row,
                passwordHash: await bcrypt.hash(plaintext, 12),
              })),
          )),
        );
      }
      const saved = await client.query(
        `INSERT INTO public.users (name, email, phone, gender, "passwordHash", role)
        SELECT r.name, r.email, NULL, r.gender::public.users_gender_enum, r."passwordHash", r.role::public.users_role_enum
        FROM jsonb_to_recordset($1::jsonb) AS r(name text, email text, gender text, "passwordHash" text, role text)
        ON CONFLICT (email) DO NOTHING RETURNING id`,
        [JSON.stringify(newUsers)],
      );
      inserted.users = saved.rowCount;
    }
    const userMap = await readUsers(client);
    if (userMap.size !== USER_COUNT)
      throw new Error('Could not provision every performance user');
    const catalogueRows = await catalogue(client, true, inserted);
    const fixtures = orderFixtures(userMap, catalogueRows);
    for (const batch of batches(fixtures)) {
      const saved = await client.query(
        `INSERT INTO public.orders (order_number, user_id, status, total_amount, inventory_reservation_id, created_at, updated_at)
        SELECT r.order_number, r.user_id, r.status::public.orders_status_enum, r.total_amount, NULL, r.created_at, r.created_at
        FROM jsonb_to_recordset($1::jsonb) AS r(order_number text, user_id integer, status text, total_amount numeric(10,2), created_at timestamptz)
        ON CONFLICT (order_number) DO NOTHING RETURNING id, order_number`,
        [JSON.stringify(batch.map(({ items, ...row }) => row))],
      );
      inserted.orders += saved.rowCount;
      const byNumber = new Map(batch.map((row) => [row.order_number, row]));
      const newItems = saved.rows.flatMap((row) => {
        const fixture = byNumber.get(row.order_number);
        return fixture.items.map((item) => ({
          order_id: row.id,
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: money(item.cents),
          created_at: fixture.created_at,
        }));
      });
      if (newItems.length) {
        const savedItems = await client.query(
          `INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, created_at, updated_at)
          SELECT r.order_id, r.product_id, r.quantity, r.unit_price, r.created_at, r.created_at
          FROM jsonb_to_recordset($1::jsonb) AS r(order_id integer, product_id integer, quantity integer, unit_price numeric(10,2), created_at timestamptz)`,
          [JSON.stringify(newItems)],
        );
        inserted.orderItems += savedItems.rowCount;
      }
    }
    const result = await collect(client);
    await client.query('COMMIT');
    return { ...result, inserted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function verifyPerformance(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await assertSchema(client);
    const result = await collect(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.mode === 'preview') {
    console.log(
      JSON.stringify(
        {
          dataset: DATASET,
          mode: 'preview; no database connection',
          totals: {
            users: USER_COUNT,
            customers: 99,
            managers: 1,
            categories: categories.length,
            products: products.length,
            orders: ORDER_COUNT,
            orderItems: 2500,
          },
          initialStatusCounts: Object.fromEntries(
            STATUSES.map((status) => [status, 200]),
          ),
          accounts: {
            customer: users[0].email,
            manager: users[USER_COUNT - 1].email,
          },
          note: 'Historical synthetic snapshots for read benchmarks; no Inventory writes or gRPC reservations. New accounts require PERF_SEED_PASSWORD.',
        },
        null,
        2,
      ),
    );
    return;
  }
  require('dotenv').config({ quiet: true });
  const config = connectionOptions(process.env, args);
  console.log(
    JSON.stringify({
      mode: args.mode,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
    }),
  );
  const client = new Client(config);
  try {
    await client.connect();
    const result =
      args.mode === 'apply'
        ? await seedPerformance(client)
        : await verifyPerformance(client);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

module.exports = {
  options,
  connectionOptions,
  seedPerformance,
  verifyPerformance,
  users,
  categories,
  products,
  orderFixtures,
};
if (require.main === module)
  main().catch((error) => {
    console.error(`Performance seed failed: ${error.message}`);
    process.exitCode = 1;
  });
