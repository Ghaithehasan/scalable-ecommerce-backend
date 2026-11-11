# Performance seed: 100 users and 1,000 orders

This manual Main API seed is the first small dataset for Requirement 3. It creates synthetic order history for **read benchmarks**, not real checkout traffic.

| Fixture                     | Count |
| --------------------------- | ----: |
| Customers                   |    99 |
| Responsible/manager account |     1 |
| Categories                  |     3 |
| Products                    |     8 |
| Orders                      | 1,000 |
| Order items                 | 2,500 |

Orders have 1-4 distinct products, quantities of 1-3, exact two-decimal price snapshots, and hourly timestamps starting on 2025-01-01. Initially each of `PENDING`, `CONFIRMED`, `SHIPPED`, `DELIVERED`, and `CANCELLED` has 200 orders. The 99 customers each own 10 or 11 orders; the manager can list all 1,000. This is a smoke dataset, not the final hundreds-of-thousands baseline.

## Safety and repeatability

- Preview is the default and does not connect to a database.
- `--apply` requires `--confirm-database <exact DB_DATABASE>`. A remote host additionally requires `--allow-remote`.
- The existing Main migrations must already be applied. No databases, tables, migrations, or schema changes are created by this seed.
- All inserts are in one transaction. An advisory lock serializes concurrent seed runs. Users, categories, products and orders have stable fixture identities; repeated runs insert only missing fixtures.
- All primary keys come from PostgreSQL sequences. No product/user/order ID is assumed.
- New users require `PERF_SEED_PASSWORD` (12-72 UTF-8 bytes). Every account gets its own bcrypt salt at cost 12. Existing passwords are preserved, and a repeat run with all users present needs no password.
- Existing rows are not updated or deleted. Existing order statuses and catalogue prices are preserved. Incompatible fixture identities, altered totals/items, or partially missing order lines cause an error and rollback instead of an overwrite.
- Categories use `perf-v1-*` slugs; users use `perf.v1.*@example.com`; order numbers use `PERF-V1-000001` through `PERF-V1-001000`.
- These rows have `inventory_reservation_id = NULL`. No gRPC calls, stock changes, or inventory-operation rows are created. Use them to test reads, pagination, filtering and authorization. Test actual checkout/reservation correctness separately through the normal API.
- Main and Inventory remain independent. There is no Inventory seed change and no cross-database query. Products in this dedicated performance catalogue have no new stock rows; a product API can report `availableQuantity: null` for them.

The fixture format is versioned. Changing the user mapping or product definitions requires a deliberate new dataset version; do not edit the fixture constants to resize this existing dataset casually.

## Preview on Windows (no database required)

From the Main repository:

```powershell
node scripts/seed-performance.cjs --preview
```

Sample login identities:

- Customer: `perf.v1.customer001@example.com`
- Manager: `perf.v1.manager@example.com`

Both initially use the password supplied at seed time. The seed never prints or stores the plaintext password in a file.

## Apply to the existing local Docker stack

From the Inventory repository. These commands use **Docker's Main database**, not PostgreSQL installed on Windows. Start the existing local stack normally first:

```powershell
docker compose -f compose.local.yaml up --build -d --wait
```

The Main Dockerfile already copies `scripts/`, so a new image includes the seed. If the image was built before this file existed, copy the two required files into the running API instead of rebuilding:

```powershell
docker compose -f compose.local.yaml cp ../e-commerce/scripts/seed-performance.cjs api:/app/scripts/seed-performance.cjs
docker compose -f compose.local.yaml cp ../e-commerce/scripts/demo-data.json api:/app/scripts/demo-data.json
```

Preview, prompt for a password without echoing it, then apply and verify. Use your actual `MAIN_DB_NAME` instead of `ecommerce` if you changed the Compose default.

```powershell
docker compose -f compose.local.yaml exec -T api node scripts/seed-performance.cjs --preview
$env:PERF_SEED_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'New performance-user password' -AsSecureString)).Password
docker compose -f compose.local.yaml exec -T -e PERF_SEED_PASSWORD api node scripts/seed-performance.cjs --apply --confirm-database ecommerce
Remove-Item Env:PERF_SEED_PASSWORD
docker compose -f compose.local.yaml exec -T api node scripts/seed-performance.cjs --verify
```

If your chat client merges lines when copying, execute each command separately or separate PowerShell statements with `;`.

To stop afterwards, preserving all data:

```powershell
docker compose -f compose.local.yaml stop
```

## Optional Azure test run (manual; not executed automatically)

Use a test environment when possible. These rows are synthetic and include a privileged demo account. No seed is part of deployment or container startup.

On the **Main VM**, after the repository contains these files, the runtime image can include them through its normal build. For an existing image, copy them from the checkout:

```bash
cd /home/azureuser/ecommerce-new
docker cp scripts/seed-performance.cjs ecommerce-api:/app/scripts/seed-performance.cjs
docker cp scripts/demo-data.json ecommerce-api:/app/scripts/demo-data.json
docker exec ecommerce-api node scripts/seed-performance.cjs --preview
```

Read the initial target line printed by the command and use the exact intended Main database name. With the documented `internet_app` database:

```bash
read -r -s -p 'New performance-user password: ' PERF_SEED_PASSWORD
export PERF_SEED_PASSWORD
docker exec -e PERF_SEED_PASSWORD ecommerce-api node scripts/seed-performance.cjs --apply --confirm-database internet_app --allow-remote
unset PERF_SEED_PASSWORD
docker exec ecommerce-api node scripts/seed-performance.cjs --verify
```

The target is inherited from the container's existing `DB_*` settings, including `DB_SSL`. Nothing needs to run on the Inventory VM. Do not run the apply command against an unintended environment. Password/account changes and consumed inventory are never reset by reruns.

## Verify

`--verify` uses a read-only transaction and checks every fixture user's identity/hash, order ownership, product references, quantities, price snapshots, totals and item counts. It reports fixture totals separately from any pre-existing data.

First apply on a database without these fixtures reports:

```json
{
  "inserted": {
    "users": 100,
    "categories": 3,
    "products": 8,
    "orders": 1000,
    "orderItems": 2500
  }
}
```

A repeated apply reports zero in every `inserted` field. Login through `POST /auth/login`, then use the returned Bearer token for `GET /orders?page=1&limit=20`. The manager's `meta.total` includes all existing orders plus these 1,000; a fixture customer sees their own 10 or 11. A new customer with no fixtures still sees no orders.

From a query tool connected to the intended **Main** database:

```sql
SELECT count(*) FROM users WHERE email LIKE 'perf.v1.%@example.com';
SELECT status, count(*) FROM orders
WHERE order_number LIKE 'PERF-V1-%' GROUP BY status ORDER BY status;
SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id
WHERE o.order_number LIKE 'PERF-V1-%';
SELECT o.order_number FROM orders o JOIN order_items i ON i.order_id = o.id
WHERE o.order_number LIKE 'PERF-V1-%'
GROUP BY o.id, o.order_number, o.total_amount
HAVING o.total_amount <> SUM(i.quantity * i.unit_price);
```

The last query should return no rows.

## Tests

```bash
npm run test:seed:performance
```

The default tests check fixture arithmetic, uniqueness and CLI target guards without a database. Set `PERF_SEED_TEST_ADMIN_URL` to a **local loopback administrative PostgreSQL connection** to enable the integration test. It creates a uniquely named disposable database, applies the actual Main migrations there, checks concurrent first runs, idempotency, generated IDs, bcrypt login compatibility, row preservation and rollback, then drops only that database. It never uses an application database as its test target or reads application `.env` automatically.

## Expand to 500,000 orders

`scripts/seed-large-orders.cjs` extends the same fixture to a target total of **500,000 orders and 1,250,000 items**. It reuses the existing 100 users and eight products; the first 1,000 orders are preserved. PostgreSQL generates new rows in 10,000-order batches without loading the dataset into Node memory. Reruns skip existing order numbers and preserve statuses, passwords and stock. New timestamps are spread across 2025; existing timestamps remain unchanged.

From Inventory with the local stack running, execute separately:

```powershell
docker compose -f compose.local.yaml cp ../e-commerce/scripts/seed-large-orders.cjs api:/app/scripts/seed-large-orders.cjs
docker compose -f compose.local.yaml exec -T api node scripts/seed-large-orders.cjs --apply --orders 500000 --confirm-database ecommerce
```

The seed verifies counts, ownership and order/item totals before committing, then runs `ANALYZE` on orders and items to refresh planner statistics. It does not add indexes or run a load test. `--orders` is the target total, not an additional count; the default is 500000 and the accepted range is 1000-999999. The default `--preview` never connects; `--verify --orders 500000` is read-only. A smaller target never deletes records above it.

For a later manual Azure test, copy `seed-large-orders.cjs`, `seed-performance.cjs` and `demo-data.json` from Main scripts into `/app/scripts/` in the existing `ecommerce-api` container, or include them in its normal image build. Use the existing container DB settings and the same remote write guard:

```bash
docker exec -e PERF_SEED_PASSWORD ecommerce-api node scripts/seed-large-orders.cjs --apply --orders 500000 --confirm-database internet_app --allow-remote
```

Supply `PERF_SEED_PASSWORD` if the 100 performance accounts do not already exist. No Azure command runs automatically.
