// Pure helpers shared by k6 and Node's contract tests. No credentials in config/report.
export function configuration(env) {
  const profile = env.K6_PROFILE || 'smoke';
  if (!['smoke', 'baseline'].includes(profile))
    throw new Error('K6_PROFILE must be smoke or baseline');
  const baseUrl = (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  if (
    !/^http:\/\/(localhost|127\.0\.0\.1|api|host\.docker\.internal)(:\d{1,5})?$/.test(
      baseUrl,
    )
  ) {
    throw new Error('This harness accepts local HTTP targets only');
  }
  const vus = Number(env.ORDERS_VUS || 5);
  if (!Number.isInteger(vus) || vus < 1 || vus > 50)
    throw new Error('ORDERS_VUS must be 1-50');
  const duration = env.ORDERS_DURATION || '30s';
  const match = /^(\d+)(s|m)$/.exec(duration);
  const durationSeconds = match
    ? Number(match[1]) * (match[2] === 'm' ? 60 : 1)
    : NaN;
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 5 ||
    durationSeconds > 300
  )
    throw new Error('ORDERS_DURATION must be 5-300 seconds, such as 30s or 1m');
  const minOrders = Number(env.K6_MIN_ORDERS || 1000);
  if (!Number.isSafeInteger(minOrders) || minOrders < 20)
    throw new Error('K6_MIN_ORDERS must be an integer >= 20');
  const label = env.K6_LABEL || 'before-small';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(label))
    throw new Error('Invalid K6_LABEL');
  return {
    profile,
    baseUrl,
    vus: profile === 'smoke' ? 1 : vus,
    duration,
    durationSeconds,
    minOrders,
    label,
    page: 1,
    limit: 20,
    thinkSeconds: 0.5,
    warmupRequests: 5,
    expectedRateLimit: 20000,
  };
}

export function header(headers, name) {
  const key = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

export function validOrdersPage(status, body, minOrders, exactTotal) {
  if (status !== 200 || !body || !Array.isArray(body.data) || !body.meta)
    return false;
  const { data, meta } = body;
  if (
    !Number.isInteger(meta.total) ||
    meta.total < minOrders ||
    (exactTotal !== undefined && meta.total !== exactTotal)
  )
    return false;
  if (
    meta.page !== 1 ||
    meta.limit !== 20 ||
    meta.totalPages !== Math.ceil(meta.total / 20) ||
    meta.hasPreviousPage !== false ||
    meta.hasNextPage !== meta.total > 20 ||
    data.length !== 20
  )
    return false;
  if (new Set(data.map((order) => order.id)).size !== data.length) return false;
  const cents = (value) => Math.round(value * 100);
  for (let index = 0; index < data.length; index++) {
    const order = data[index];
    if (
      !Number.isInteger(order.id) ||
      !Number.isInteger(order.userId) ||
      !Number.isFinite(order.totalAmount) ||
      !Array.isArray(order.items) ||
      !order.items.length
    )
      return false;
    let total = 0;
    for (const item of order.items) {
      if (
        !Number.isInteger(item.productId) ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        typeof item.productName !== 'string' ||
        !item.productName ||
        !Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        !Number.isFinite(item.lineTotal)
      )
        return false;
      const line = cents(item.unitPrice) * item.quantity;
      if (cents(item.lineTotal) !== line) return false;
      total += line;
    }
    if (cents(order.totalAmount) !== total) return false;
    const time = Date.parse(order.createdAt);
    if (!Number.isFinite(time)) return false;
    if (index) {
      const previous = data[index - 1];
      const previousTime = Date.parse(previous.createdAt);
      if (
        time > previousTime ||
        (time === previousTime && order.id > previous.id)
      )
        return false;
    }
  }
  return true;
}

export function reportFromSummary(data, config) {
  // k6 v2 uses results.metrics; the fallback also permits native k6 v1 summaries.
  const metrics =
    data.metrics ||
    Object.fromEntries(
      (data.results?.metrics || []).map((metric) => [metric.name, metric]),
    );
  const values = (name) => metrics[name]?.values || {};
  const duration = values('orders_duration_ms');
  const requests = values('orders_requests').count || 0;
  const failedRate = values('orders_failed').rate ?? null;
  const rateLimited = values('orders_429').count || 0;
  const latencyMs = {
    p50: duration['p(50)'] ?? duration.med ?? null,
    p95: duration['p(95)'] ?? null,
    p99: duration['p(99)'] ?? null,
    avg: duration.avg ?? null,
    min: duration.min ?? null,
    max: duration.max ?? null,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workload: {
      ...config,
      path: '/orders?page=1&limit=20',
      role: 'RESPONSIBLE',
      measuredIterations: config.profile === 'smoke' ? 10 : null,
    },
    observedTotalOrders: values('dataset_orders').value ?? null,
    measured: { requests, failedRate, rateLimited, latencyMs },
    valid:
      requests > 0 &&
      (config.profile !== 'smoke' || requests === 10) &&
      failedRate === 0 &&
      rateLimited === 0 &&
      Object.values(latencyMs).every((value) => Number.isFinite(value)),
    k6Version: data.metadata?.k6Version || null,
    // k6 summaries can contain setup_data (our JWT). Persist metric values only.
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, metric]) => [
        name,
        { type: metric.type, values: metric.values },
      ]),
    ),
  };
}
