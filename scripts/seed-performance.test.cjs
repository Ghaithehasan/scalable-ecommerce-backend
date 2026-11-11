const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const seed = require('./seed-performance.cjs');

test('preview is the default and CLI write guards require an exact target', () => {
  assert.equal(seed.options([]).mode, 'preview');
  assert.throws(() => seed.options(['--apply', '--verify']), /only one/);
  assert.throws(() => seed.options(['--confirm-database']), /incomplete/);
  const env = {
    DB_HOST: 'postgres',
    DB_DATABASE: 'ecommerce',
    DB_USERNAME: 'main_api',
    DB_PASSWORD: 'test-only',
  };
  assert.throws(
    () => seed.connectionOptions(env, seed.options(['--apply'])),
    /confirm-database/,
  );
  assert.throws(
    () =>
      seed.connectionOptions(
        env,
        seed.options(['--apply', '--confirm-database', 'wrong']),
      ),
    /confirm-database/,
  );
  assert.equal(
    seed.connectionOptions(
      env,
      seed.options(['--apply', '--confirm-database', 'ecommerce']),
    ).database,
    'ecommerce',
  );
  const remote = {
    ...env,
    DB_HOST: 'example.postgres.database.azure.com',
    DB_SSL: 'true',
  };
  assert.throws(
    () =>
      seed.connectionOptions(
        remote,
        seed.options(['--apply', '--confirm-database', 'ecommerce']),
      ),
    /allow-remote/,
  );
  assert.deepEqual(
    seed.connectionOptions(
      remote,
      seed.options([
        '--apply',
        '--confirm-database',
        'ecommerce',
        '--allow-remote',
      ]),
    ).ssl,
    { rejectUnauthorized: true },
  );
});

test('fixtures contain 100 users, 1,000 orders and 2,500 distinct product lines', () => {
  const userMap = new Map(
    seed.users.map((row, index) => [row.email, { ...row, id: 500 + index }]),
  );
  const products = seed.products.map((row, index) => ({
    ...row,
    id: 900 + index,
  }));
  const orders = seed.orderFixtures(userMap, products);
  assert.equal(seed.users.length, 100);
  assert.equal(
    seed.users.filter((row) => row.role === 'RESPONSIBLE').length,
    1,
  );
  assert.equal(orders.length, 1000);
  assert.equal(
    orders.reduce((sum, row) => sum + row.items.length, 0),
    2500,
  );
  assert.equal(new Set(orders.map((row) => row.order_number)).size, 1000);
  for (const order of orders) {
    assert.equal(
      new Set(order.items.map((row) => row.product_id)).size,
      order.items.length,
    );
    assert.equal(
      Math.round(Number(order.total_amount) * 100),
      order.items.reduce((sum, row) => sum + row.cents * row.quantity, 0),
    );
    assert.ok(order.user_id >= 500 && order.user_id < 599);
  }
});

// Opt-in integration test: creates and drops ONLY its own disposable local database.
// It never reads .env or uses an application database as its test target.
test(
  'real PostgreSQL: atomicity, generated IDs, salted passwords, concurrent reruns and preservation',
  {
    skip: !process.env.PERF_SEED_TEST_ADMIN_URL,
    timeout: 180000,
  },
  async () => {
    const url = new URL(process.env.PERF_SEED_TEST_ADMIN_URL);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      'Integration tests require a loopback PostgreSQL host',
    );
    const database = `seed_perf_test_${randomBytes(8).toString('hex')}`;
    const admin = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5000,
    });
    const clients = [];
    let created = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      const target = new URL(url);
      target.pathname = `/${database}`;
      for (let index = 0; index < 2; index++) {
        const client = new Client({
          connectionString: target.toString(),
          statement_timeout: 120000,
        });
        await client.connect();
        clients.push(client);
      }
      const [client, second] = clients;
      const root =
        process.env.PERF_SEED_TEST_REPO || path.resolve(__dirname, '..');
      const ts = require('typescript');
      for (const file of [
        '1793744493449-InitialSchema.ts',
        '1794268800000-AddInventoryOrderOperations.ts',
      ]) {
        const filename = path.join(root, 'src', 'migrations', file);
        const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        });
        const migrationModule = new Module(filename, module);
        migrationModule.paths = module.paths;
        migrationModule._compile(compiled.outputText, filename);
        const Migration = Object.values(migrationModule.exports).find(
          (value) => typeof value === 'function',
        );
        await new Migration().up({
          query: async (sql, params) => (await client.query(sql, params)).rows,
        });
      }
      // Move all sequences away from fixture indexes: the seed must use RETURNING IDs.
      for (const table of [
        'users',
        'categories',
        'products',
        'orders',
        'order_items',
      ]) {
        await client.query(
          'SELECT setval(pg_get_serial_sequence($1, $2), $3, false)',
          [table, 'id', 500],
        );
      }
      await assert.rejects(
        seed.seedPerformance(client, {}),
        /PERF_SEED_PASSWORD/,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM public.users'))
          .rows[0].n,
        0,
      );
      const plaintext = randomBytes(24).toString('hex');
      const results = await Promise.all([
        seed.seedPerformance(client, { PERF_SEED_PASSWORD: plaintext }),
        seed.seedPerformance(second, { PERF_SEED_PASSWORD: plaintext }),
      ]);
      assert.equal(
        results.reduce((sum, result) => sum + result.inserted.users, 0),
        100,
      );
      assert.equal(
        results.reduce((sum, result) => sum + result.inserted.orders, 0),
        1000,
      );
      assert.equal(
        results.reduce((sum, result) => sum + result.inserted.orderItems, 0),
        2500,
      );
      const verified = await seed.verifyPerformance(client);
      assert.deepEqual(verified.totals, {
        users: 100,
        categories: 3,
        products: 8,
        orders: 1000,
        orderItems: 2500,
      });
      assert.ok(
        verified.orderExamples.every(
          (row) => row.id >= 500 && row.user_id >= 500,
        ),
      );
      const account = (
        await client.query(
          'SELECT id, "passwordHash" FROM public.users WHERE email = $1',
          [seed.users[0].email],
        )
      ).rows[0];
      assert.ok(await bcrypt.compare(plaintext, account.passwordHash));
      assert.equal(
        (
          await client.query(
            'SELECT count(DISTINCT "passwordHash")::int AS n FROM public.users',
          )
        ).rows[0].n,
        100,
      );

      const replacementHash = await bcrypt.hash(
        randomBytes(24).toString('hex'),
        12,
      );
      await client.query(
        'UPDATE public.users SET "passwordHash" = $1 WHERE id = $2',
        [replacementHash, account.id],
      );
      await client.query(
        "UPDATE public.orders SET status = 'CANCELLED' WHERE order_number = 'PERF-V1-000001'",
      );
      const product = (
        await client.query(
          'SELECT id, price FROM public.products ORDER BY id LIMIT 1',
        )
      ).rows[0];
      await client.query(
        'UPDATE public.products SET price = 99.99 WHERE id = $1',
        [product.id],
      );
      await client.query(
        'INSERT INTO public.categories (name, slug) VALUES ($1, $2)',
        ['Existing category', 'existing-unrelated-category'],
      );
      const rerun = await seed.seedPerformance(client, {});
      assert.deepEqual(rerun.inserted, {
        users: 0,
        categories: 0,
        products: 0,
        orders: 0,
        orderItems: 0,
      });
      assert.equal(
        (
          await client.query(
            'SELECT "passwordHash" FROM public.users WHERE id = $1',
            [account.id],
          )
        ).rows[0].passwordHash,
        replacementHash,
      );
      assert.equal(
        (
          await client.query(
            "SELECT status FROM public.orders WHERE order_number = 'PERF-V1-000001'",
          )
        ).rows[0].status,
        'CANCELLED',
      );
      assert.equal(
        (
          await client.query(
            'SELECT price FROM public.products WHERE id = $1',
            [product.id],
          )
        ).rows[0].price,
        '99.99',
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM public.categories WHERE slug = 'existing-unrelated-category'",
          )
        ).rows[0].n,
        1,
      );

      await client.query('UPDATE public.users SET name = $1 WHERE id = $2', [
        'Unrelated account',
        account.id,
      ]);
      await assert.rejects(seed.seedPerformance(client, {}), /email collision/);
      assert.equal(
        (
          await client.query('SELECT name FROM public.users WHERE id = $1', [
            account.id,
          ])
        ).rows[0].name,
        'Unrelated account',
      );
      await client.query('UPDATE public.users SET name = $1 WHERE id = $2', [
        seed.users[0].name,
        account.id,
      ]);

      const before = (
        await client.query(
          "SELECT id, total_amount FROM public.orders WHERE order_number = 'PERF-V1-000001'",
        )
      ).rows[0];
      await client.query(
        'UPDATE public.orders SET total_amount = total_amount + 1 WHERE id = $1',
        [before.id],
      );
      await assert.rejects(
        seed.seedPerformance(client, {}),
        /Conflicting performance order/,
      );
      assert.equal(
        (
          await client.query(
            'SELECT total_amount FROM public.orders WHERE id = $1',
            [before.id],
          )
        ).rows[0].total_amount,
        (Number(before.total_amount) + 1).toFixed(2),
      );
      await client.query(
        'UPDATE public.orders SET total_amount = $1 WHERE id = $2',
        [before.total_amount, before.id],
      );
      await seed.verifyPerformance(client);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      if (created && /^seed_perf_test_[a-f0-9]{16}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
      await admin.end();
    }
  },
);
