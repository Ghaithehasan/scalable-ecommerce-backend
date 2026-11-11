# Local orders benchmark (Requirement 3, part 1)

This suite measures the existing authenticated `GET /orders?page=1&limit=20` route using the seeded RESPONSIBLE account. It uses the current two-repository Docker stack. No Azure resources, databases, seeds, or checkout/reservation operations are created by the runner.

## Files

| File                                            | Responsibility                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `orders.k6.js`                                  | Login once, warm up, issue reads, collect metrics                                       |
| `orders-contract.mjs`                           | Validate configuration, response data, and report format                                |
| `orders-contract.test.cjs`                      | Reject false successes and credential leakage                                           |
| `run.cjs`                                       | Start local performance settings, run Docker k6, save JSON, restore normal API settings |
| `../inventory-service/compose.performance.yaml` | Local API rate-limit override and pinned k6 container                                   |
| `results/*.json`                                | Generated reports, ignored by Git                                                       |

## Prerequisites

- Docker Desktop running Linux containers; the normal Inventory `compose.local.yaml` settings are configured.
- The two sibling checkouts are named `e-commerce` and `inventory-service`, as in the existing combined Compose file.
- Main's existing migrations and performance seed have already been applied to **Docker's Main database**. The seed supplies 100 users, 1,000 orders and 2,500 items. The benchmark does not seed automatically.
- A RESPONSIBLE account, normally `perf.v1.manager@example.com`, and its original seed password.

## Quick start (Windows PowerShell)

Run from the **Main API repository**. First enter the manager's seed password without echoing it, then run a smoke test. The first run needs `--build` so the local API image includes the configurable rate limit. The flag builds Main only; later runs can use the cached image.

```powershell
$env:K6_MANAGER_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Performance manager password' -AsSecureString)).Password; npm.cmd run perf:orders:smoke -- --build
```

Then run the initial 5-user, 30-second baseline:

```powershell
npm.cmd run perf:orders:baseline -- --vus 5 --duration 30s --label before-1000
```

The password can alternatively be stored as `K6_MANAGER_PASSWORD` in Main's ignored `.env`. `K6_MANAGER_EMAIL` can select another RESPONSIBLE account. There is no password in scripts, commands committed to Git, or output reports. Set `DOCKER_BIN` to the Docker executable if its path cannot be detected.

On Bash, export the password using a silent prompt and use `npm` instead of `npm.cmd`:

```bash
read -r -s -p 'Performance manager password: ' K6_MANAGER_PASSWORD
export K6_MANAGER_PASSWORD
npm run perf:orders:smoke -- --build
npm run perf:orders:baseline -- --vus 5 --duration 30s --label before-1000
unset K6_MANAGER_PASSWORD
```

## Workload

| Profile    |                     Clients | Measured reads                                        | Pacing                           |
| ---------- | --------------------------: | ----------------------------------------------------- | -------------------------------- |
| `smoke`    |                        1 VU | 10 reads, maximum 30 seconds                          | 0.5-second pause after each read |
| `baseline` | Configurable, default 5 VUs | Constant concurrent clients for 30 seconds by default | Same 0.5-second pause            |

Every run logs in **once** during setup. All VUs reuse that manager token. The five warmup reads and login are excluded from the custom orders latency metric. The test checks token lifetime before load. It uses a closed workload: the number of concurrent clients is fixed, not an exact requests-per-second target.

The runner uses custom `ORDERS_VUS` and `ORDERS_DURATION` environment variables internally so k6's built-in execution shortcuts do not override the explicit scenarios. A valid smoke report must contain exactly ten measured reads.

The suite checks HTTP 200, exactly 20 orders, page metadata, a stable total, descending order, product names, quantities, and integer-cent line/order totals. A 401, 403, 429, timeout, empty page or malformed response is a failure. Concurrent writes that change the total can invalidate this read-only comparison; run one benchmark at a time and keep the dataset stable.

Defaults are page 1, limit 20, five warmup reads, and a minimum of 1,000 total orders. Future larger fixtures can be checked explicitly:

```powershell
npm.cmd run perf:orders:baseline -- --vus 10 --duration 1m --min-orders 200000 --label before-200k
```

That example requires those rows to already exist; the current small seed is not automatically enlarged.

## Rate limiting and normal operation

The Main API's normal limit stays **60 requests per 60 seconds**. `HTTP_RATE_LIMIT` is an explicit configurable request count, validated at startup. Login/register keep their separate **5 requests per minute** rules.

Only the local performance overlay sets `HTTP_RATE_LIMIT=20000`. JWT validation, current-user lookup, ownership and role checks still run on every orders request. Setup verifies the API's rate-limit response header before measuring so an old image or wrong configuration cannot quietly produce fast 429 responses.

On normal completion or a handled failure, the runner recreates the API using **only `compose.local.yaml`**, removing the temporary override. PostgreSQL, Inventory and Main remain running for Postman. No volume is removed. Do not launch an ordinary Compose command concurrently with a running benchmark, because it would change this setting mid-test.

If you force-close the terminal or interrupt the Docker process, restore normal API settings from Inventory explicitly:

```powershell
docker compose -f compose.local.yaml up -d --no-deps --wait api
```

If login returns 429, respect `Retry-After` before rerunning; the suite does not bypass login throttling. If setup reports a missing performance limit, rebuild using `--build`. An old image cannot read the new configuration.

## Results

Each run writes a timestamped JSON report under `performance/results/`. Existing reports are not overwritten. It records:

- Orders-only latency in milliseconds: **p50, p95, p99, average, minimum and maximum**.
- Measured request count, failure rate and number of 429 responses.
- Observed order count, profile, duration, VUs, pacing, and warmup policy.
- API image ID, application Git commit/dirty flag, pinned k6 version and basic host hardware information.
- Numeric k6 metric values, **excluding setup data, JWTs, passwords and environment dumps**.

`valid: true` requires measured samples, zero failed responses/checks, zero 429s and a successful k6 exit. Invalid reports are saved for debugging and the runner exits nonzero. No arbitrary latency target is imposed before we have a real baseline.

The smoke percentiles describe only ten samples and are not useful tail-latency evidence. A 1,000-order baseline is preliminary; the assignment's final before/after comparison needs the large dataset, identical workload, hardware, and warmup policy. Record multiple workload sizes separately rather than comparing different VU counts as if they were the same test. The load generator shares the local machine with Docker, and this is not an Azure performance measurement.

## Contract tests

```powershell
npm.cmd run test:performance
```

These tests do not contact a database or server. The Docker smoke test then verifies the actual k6 runtime, authentication, contract checks, configuration and JSON report export against the real local API.

References: [k6 custom summaries](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/), [official machine-readable summary schema](https://github.com/grafana/k6-summary), [NestJS rate limiting](https://docs.nestjs.com/security/rate-limiting).
