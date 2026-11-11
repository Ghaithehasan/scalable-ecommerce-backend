// Expand the existing performance fixture without loading millions of rows in Node.
// Manual only: PostgreSQL generates order history; Inventory is never contacted.
const { Client } = require('pg');
const small = require('./seed-performance.cjs');
const STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const DEFAULT_ORDERS = 500000;
const BATCH = 10000;

function options(argv) {
  const rest = [];
  let orders = DEFAULT_ORDERS;
  let explicit = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--orders') {
      if (explicit || !argv[i + 1])
        throw new Error('Provide --orders once with a target count');
      explicit = true;
      orders = Number(argv[++i]);
    } else rest.push(argv[i]);
  }
  if (!Number.isSafeInteger(orders) || orders < 1000 || orders > 999999)
    throw new Error(
      '--orders must be 1000-999999 (a target total, not an additional count)',
    );
  return { ...small.options(rest), orders };
}

function expectedItems(orders) {
  return Math.floor(orders / 4) * 10 + [0, 1, 3, 6][orders % 4];
}

async function identifiers(client) {
  const customerFixtures = small.users.filter((row) => row.role === 'CUSTOMER');
  const { rows: users } = await client.query(
    'SELECT id, email FROM public.users WHERE email = ANY($1::text[])',
    [customerFixtures.map((row) => row.email)],
  );
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  const { rows: products } = await client.query(
    'SELECT p.id, p.name, c.slug FROM public.products p JOIN public.categories c ON c.id = p.category_id WHERE c.slug = ANY($1::text[])',
    [small.categories.map((row) => row.slug)],
  );
  const customerIds = customerFixtures.map((row) => byEmail.get(row.email));
  const productIds = small.products.map((fixture) => {
    const matches = products.filter(
      (row) => row.name === fixture.name && row.slug === fixture.category,
    );
    if (matches.length !== 1)
      throw new Error(
        `Missing or conflicting fixture product: ${fixture.name}`,
      );
    return matches[0].id;
  });
  if (customerIds.some((id) => !id))
    throw new Error('Missing performance customers');
  return {
    customerIds,
    productIds,
    cents: small.products.map((row) => row.cents),
  };
}

const INSERT_BATCH = `
WITH planned AS MATERIALIZED (
  SELECT g.i,
    'PERF-V1-' || lpad((g.i + 1)::text, 6, '0') AS order_number,
    ($3::int[])[1 + g.i % array_length($3::int[], 1)] AS user_id,
    ($6::text[])[1 + g.i % 5]::public.orders_status_enum AS status,
    TIMESTAMPTZ '2025-01-01 00:00:00+00' + (g.i % 525600) * INTERVAL '1 minute' AS created_at,
    (SELECT sum((($5::int[])[1 + (g.i + l.line) % array_length($5::int[], 1)]) * (1 + (g.i + l.line) % 3)) / 100.0
     FROM generate_series(0, g.i % 4) AS l(line)) AS total_amount
  FROM generate_series($1::int, $2::int) AS g(i)
), inserted AS (
  INSERT INTO public.orders (order_number, user_id, status, total_amount, inventory_reservation_id, created_at, updated_at)
  SELECT p.order_number, p.user_id, p.status, p.total_amount, NULL, p.created_at, p.created_at
  FROM planned p
  WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.order_number = p.order_number)
  ON CONFLICT (order_number) DO NOTHING
  RETURNING id, order_number, created_at
), inserted_items AS (
  INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, created_at, updated_at)
  SELECT o.id,
    ($4::int[])[1 + (p.i + l.line) % array_length($4::int[], 1)],
    1 + (p.i + l.line) % 3,
    (($5::int[])[1 + (p.i + l.line) % array_length($5::int[], 1)]) / 100.0,
    o.created_at, o.created_at
  FROM inserted o JOIN planned p ON p.order_number = o.order_number
  CROSS JOIN LATERAL generate_series(0, p.i % 4) AS l(line)
  RETURNING id
)
SELECT (SELECT count(*)::int FROM inserted) AS orders,
       (SELECT count(*)::int FROM inserted_items) AS items`;

async function verify(client, target, ids) {
  const last = 'PERF-V1-' + String(target).padStart(6, '0');
  const { rows } = await client.query(
    `
    WITH scoped AS MATERIALIZED (
      SELECT id, user_id, total_amount, inventory_reservation_id,
             substring(order_number FROM 9)::int - 1 AS i
      FROM public.orders
      WHERE order_number >= 'PERF-V1-000001' AND order_number <= $1
        AND order_number ~ '^PERF-V1-[0-9]{6}$'
    ), line_totals AS (
      SELECT oi.order_id, count(*) AS lines, sum(oi.quantity * oi.unit_price) AS amount
      FROM public.order_items oi JOIN scoped s ON s.id = oi.order_id
      GROUP BY oi.order_id
    )
    SELECT count(*)::int AS orders, COALESCE(sum(t.lines), 0)::int AS items,
      count(*) FILTER (WHERE t.lines IS NULL OR t.lines <> 1 + s.i % 4
        OR t.amount <> s.total_amount OR s.inventory_reservation_id IS NOT NULL
        OR NOT (s.user_id = ANY($2::int[])))::int AS invalid
    FROM scoped s LEFT JOIN line_totals t ON t.order_id = s.id`,
    [last, ids.customerIds],
  );
  const totals = rows[0];
  if (
    totals.orders !== target ||
    totals.items !== expectedItems(target) ||
    totals.invalid !== 0
  )
    throw new Error(`Verification failed: ${JSON.stringify(totals)}`);
  const statuses = await client.query(
    `SELECT status, count(*)::int AS orders FROM public.orders
    WHERE order_number >= 'PERF-V1-000001' AND order_number <= $1
      AND order_number ~ '^PERF-V1-[0-9]{6}$' GROUP BY status ORDER BY status`,
    [last],
  );
  return {
    orders: totals.orders,
    orderItems: totals.items,
    invalidOrders: totals.invalid,
    statusCounts: Object.fromEntries(
      statuses.rows.map((row) => [row.status, row.orders]),
    ),
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.mode === 'preview') {
    console.log(
      JSON.stringify(
        {
          mode: 'preview; no database connection',
          targetOrders: args.orders,
          targetOrderItems: expectedItems(args.orders),
          users: 100,
          note: 'Extends the same PERF-V1 dataset. Existing orders, passwords and Inventory stock are preserved.',
        },
        null,
        2,
      ),
    );
    return;
  }
  require('dotenv').config({ quiet: true });
  const config = {
    ...small.connectionOptions(process.env, args),
    statement_timeout: 120000,
    application_name: 'manual-large-performance-seed-v1',
  };
  console.log(
    JSON.stringify({
      mode: args.mode,
      host: config.host,
      database: config.database,
      targetOrders: args.orders,
    }),
  );
  const client = new Client(config);
  try {
    await client.connect();
    // This preserves/provisions the original 100 users, catalogue and first 1,000 orders.
    if (args.mode === 'apply') await small.seedPerformance(client);
    else await small.verifyPerformance(client);
    await client.query(
      args.mode === 'apply'
        ? 'BEGIN'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    let result;
    try {
      if (args.mode === 'apply') {
        await client.query("SET LOCAL lock_timeout = '60s'");
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          ['ecommerce-performance-v1'],
        );
      }
      const ids = await identifiers(client);
      const inserted = { orders: 0, orderItems: 0 };
      if (args.mode === 'apply') {
        for (let start = 1000; start < args.orders; start += BATCH) {
          const end = Math.min(start + BATCH, args.orders) - 1;
          const { rows } = await client.query(INSERT_BATCH, [
            start,
            end,
            ids.customerIds,
            ids.productIds,
            ids.cents,
            STATUSES,
          ]);
          inserted.orders += rows[0].orders;
          inserted.orderItems += rows[0].items;
          if ((end + 1 - 1000) % 50000 === 0 || end + 1 === args.orders)
            console.log(`Processed ${end + 1}/${args.orders} target orders`);
        }
      }
      result = {
        ...(await verify(client, args.orders, ids)),
        ...(args.mode === 'apply' ? { inserted } : {}),
      };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify(result, null, 2));
    if (args.mode === 'apply') {
      await client.query('ANALYZE public.orders');
      await client.query('ANALYZE public.order_items');
      console.log(
        'Updated PostgreSQL table statistics. No application optimization or load test was run.',
      );
    }
  } finally {
    await client.end();
  }
}

module.exports = { options, expectedItems };
if (require.main === module)
  main().catch((error) => {
    console.error(`Large seed failed: ${error.message}`);
    process.exitCode = 1;
  });
