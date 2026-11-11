import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import {
  configuration,
  header,
  reportFromSummary,
  validOrdersPage,
} from './orders-contract.mjs';

const config = configuration(__ENV);
const duration = new Trend('orders_duration_ms', true);
const requests = new Counter('orders_requests');
const failed = new Rate('orders_failed');
const rateLimited = new Counter('orders_429');
const dataset = new Gauge('dataset_orders');

export const options = {
  setupTimeout: '45s',
  summaryTrendStats: ['avg', 'min', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    orders:
      config.profile === 'smoke'
        ? {
            executor: 'shared-iterations',
            vus: 1,
            iterations: 10,
            maxDuration: '30s',
            gracefulStop: '5s',
          }
        : {
            executor: 'constant-vus',
            vus: config.vus,
            duration: config.duration,
            gracefulStop: '5s',
          },
  },
  thresholds: {
    orders_requests: ['count>0'],
    orders_failed: ['rate==0'],
    orders_429: ['count==0'],
  },
};

function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function readOrders(token, phase) {
  return http.get(`${config.baseUrl}/orders?page=1&limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'GET /orders', phase },
    timeout: '10s',
    redirects: 0,
  });
}

export function setup() {
  if (!__ENV.K6_MANAGER_PASSWORD)
    fail('Set K6_MANAGER_PASSWORD; credentials are never stored in reports');
  const response = http.post(
    `${config.baseUrl}/auth/login`,
    JSON.stringify({
      email: __ENV.K6_MANAGER_EMAIL || 'perf.v1.manager@example.com',
      password: __ENV.K6_MANAGER_PASSWORD,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /auth/login', phase: 'setup' },
      timeout: '10s',
      redirects: 0,
    },
  );
  if (response.status !== 200)
    fail(
      `Login failed: HTTP ${response.status}; Retry-After=${header(response.headers, 'retry-after') || 'n/a'} seconds`,
    );
  const auth = json(response);
  if (!auth?.accessToken || auth.user?.role !== 'RESPONSIBLE')
    fail('The benchmark requires a valid RESPONSIBLE account');
  const requiredTtl =
    (config.profile === 'smoke' ? 30 : config.durationSeconds) + 20;
  if (Number(auth.expiresIn) < requiredTtl)
    fail(
      'Access token lifetime is shorter than this test; choose a shorter duration',
    );
  let total;
  for (let index = 0; index < config.warmupRequests; index++) {
    const warmup = readOrders(auth.accessToken, 'warmup');
    const body = json(warmup);
    if (!validOrdersPage(warmup.status, body, config.minOrders, total))
      fail(
        `Warmup failed: HTTP ${warmup.status}; ensure the performance seed exists and the response contract is valid`,
      );
    if (
      Number(header(warmup.headers, 'x-ratelimit-limit')) !==
      config.expectedRateLimit
    )
      fail(
        'The local performance rate limit is not active. Rebuild Main with --build and use compose.performance.yaml',
      );
    total = body.meta.total;
    sleep(0.1);
  }
  dataset.add(total);
  return { token: auth.accessToken, total };
}

export default function (session) {
  const response = readOrders(session.token, 'measure');
  const valid = validOrdersPage(
    response.status,
    json(response),
    config.minOrders,
    session.total,
  );
  requests.add(1);
  duration.add(response.timings.duration);
  failed.add(!valid);
  rateLimited.add(response.status === 429 ? 1 : 0);
  check(
    response,
    {
      'orders HTTP 200': (value) => value.status === 200,
      'pagination, ordering, product relations and totals are valid': () =>
        valid,
    },
    { phase: 'measure' },
  );
  sleep(config.thinkSeconds);
}

export function handleSummary(data) {
  const report = reportFromSummary(data, config);
  const latency = report.measured.latencyMs;
  const dataset = String(report.observedTotalOrders);
  const load =
    config.profile === 'smoke'
      ? '1 VU, 10 requests'
      : `${config.vus} VUs, ${config.duration}`;
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  const milliseconds = (value) => `${value.toFixed(2)}ms`;
  const message = [
    `Orders benchmark: ${config.label}`,
    `Dataset: ${dataset} orders | Load: ${load} | GET ${report.workload.path}`,
    `Measured: ${report.measured.requests} requests | Errors: ${percent(report.measured.failedRate)} | HTTP 429: ${report.measured.rateLimited}`,
    `Latency: p50=${milliseconds(latency.p50)} | p95=${milliseconds(latency.p95)} | p99=${milliseconds(latency.p99)}`,
    '',
  ].join('\n');
  // The host runner writes JSON. No writable Docker volume or remote JS import.
  return {
    stdout: message + 'K6_REPORT_JSON=' + JSON.stringify(report) + '\n',
  };
}
