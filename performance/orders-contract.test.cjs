const { test } = require('node:test');
const assert = require('node:assert/strict');

async function helpers() {
  return import('./orders-contract.mjs');
}
function page() {
  return {
    data: Array.from({ length: 20 }, (_, index) => ({
      id: 20 - index,
      userId: 1,
      totalAmount: 34.9,
      createdAt: '2025-01-01T00:00:00Z',
      items: [
        {
          productId: 10,
          productName: 'Keyboard',
          quantity: 1,
          unitPrice: 34.9,
          lineTotal: 34.9,
        },
      ],
    })),
    meta: {
      page: 1,
      limit: 20,
      total: 1000,
      totalPages: 50,
      hasPreviousPage: false,
      hasNextPage: true,
    },
  };
}

test('HTTP errors, empty pages, missing relations and incorrect money cannot pass', async () => {
  const { validOrdersPage } = await helpers();
  assert.equal(validOrdersPage(200, page(), 1000, 1000), true);
  for (const status of [0, 304, 401, 403, 429, 500])
    assert.equal(validOrdersPage(status, page(), 1000, 1000), false);
  const empty = page();
  empty.data = [];
  assert.equal(validOrdersPage(200, empty, 1000), false);
  const relation = page();
  relation.data[0].items[0].productName = null;
  assert.equal(validOrdersPage(200, relation, 1000), false);
  const money = page();
  money.data[0].totalAmount = 99;
  assert.equal(validOrdersPage(200, money, 1000), false);
  const line = page();
  line.data[0].items[0].lineTotal = 99;
  assert.equal(validOrdersPage(200, line, 1000), false);
  const duplicate = page();
  duplicate.data[1].id = duplicate.data[0].id;
  assert.equal(validOrdersPage(200, duplicate, 1000), false);
  const changed = page();
  changed.meta.total = 1001;
  changed.meta.totalPages = 51;
  assert.equal(validOrdersPage(200, changed, 1000, 1000), false);
});

test('local workload configuration is bounded and smoke uses one VU', async () => {
  const { configuration } = await helpers();
  assert.equal(configuration({}).vus, 1);
  assert.equal(
    configuration({ K6_PROFILE: 'baseline', ORDERS_VUS: '5' }).vus,
    5,
  );
  assert.throws(
    () => configuration({ BASE_URL: 'https://production.example.com' }),
    /local/,
  );
  assert.throws(() => configuration({ ORDERS_VUS: '1000' }), /1-50/);
  assert.throws(() => configuration({ ORDERS_DURATION: '1h' }), /5-300/);
  assert.throws(() => configuration({ K6_LABEL: '../escape' }), /Invalid/);
});

test('summary uses measured orders only and rejects deceptively fast failed requests', async () => {
  const { reportFromSummary, configuration } = await helpers();
  const metrics = [
    {
      name: 'orders_duration_ms',
      values: {
        'p(50)': 10,
        'p(95)': 20,
        'p(99)': 25,
        avg: 12,
        min: 8,
        max: 30,
      },
    },
    { name: 'orders_requests', values: { count: 10 } },
    { name: 'orders_failed', values: { rate: 0 } },
    { name: 'orders_429', values: { count: 0 } },
    { name: 'dataset_orders', values: { value: 1000 } },
  ];
  const report = reportFromSummary({ results: { metrics } }, configuration({}));
  assert.equal(report.valid, true);
  assert.equal(report.measured.latencyMs.p99, 25);
  assert.equal(report.observedTotalOrders, 1000);
  metrics.find((metric) => metric.name === 'orders_requests').values.count = 11;
  assert.equal(
    reportFromSummary({ results: { metrics } }, configuration({})).valid,
    false,
  );
  metrics.find((metric) => metric.name === 'orders_requests').values.count = 10;
  metrics.find((metric) => metric.name === 'orders_429').values.count = 10;
  metrics.find((metric) => metric.name === 'orders_failed').values.rate = 1;
  assert.equal(
    reportFromSummary({ results: { metrics } }, configuration({})).valid,
    false,
  );
  assert.equal(reportFromSummary({}, configuration({})).valid, false);
  const safe = reportFromSummary(
    {
      setup_data: { token: 'sensitive-token' },
      config: { env: { K6_MANAGER_PASSWORD: 'sensitive-password' } },
      results: { metrics },
    },
    configuration({}),
  );
  assert.equal(JSON.stringify(safe).includes('sensitive-token'), false);
  assert.equal(JSON.stringify(safe).includes('sensitive-password'), false);
});
