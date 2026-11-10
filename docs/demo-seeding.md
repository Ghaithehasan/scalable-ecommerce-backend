# Manual demo data

These scripts only insert missing demo rows. They never recreate a database, run migrations, delete rows, or update existing stock, prices, passwords, or roles. They are not connected to startup, Docker entrypoints, or deployment hooks. `--apply` is the only mode that writes to a database; the default is an offline preview.

Main and Inventory keep their existing, separate database connections. Main owns categories, products, prices, and users. Inventory owns `inventory_stock` and reservations. No cross-database foreign keys or new migrations are needed.

## Data preview

Prices below are illustrative catalogue amounts in the application's existing price unit; no currency schema is introduced.

| Category            | Product                          | Price | Initial stock |
| ------------------- | -------------------------------- | ----: | ------------: |
| Electronics         | Wireless Compact Keyboard        | 34.90 |           120 |
| Electronics         | Ergonomic Wireless Mouse         | 19.90 |             5 |
| Electronics         | 65W USB-C Wall Charger           | 29.90 |             0 |
| Home & Kitchen      | Stainless Steel Water Bottle     | 18.50 |            80 |
| Home & Kitchen      | Ceramic Coffee Mug               | 12.00 |             3 |
| Home & Kitchen      | Digital Kitchen Scale            | 24.90 |             0 |
| Office & Stationery | A5 Hardcover Notebook            |  8.90 |           200 |
| Office & Stationery | Adjustable Aluminum Laptop Stand | 39.90 |             2 |

| Fictional user | Email                     | Role        | Password supplied through |
| -------------- | ------------------------- | ----------- | ------------------------- |
| Maya Demo      | maya.customer@example.com | CUSTOMER    | DEMO_CUSTOMER_PASSWORD    |
| Omar Demo      | omar.manager@example.com  | RESPONSIBLE | DEMO_MANAGER_PASSWORD     |

Phone numbers are NULL. New passwords must contain 12-72 UTF-8 bytes and are hashed with bcrypt cost 12, compatible with the existing login implementation. There are no default passwords, and passwords and hashes are never printed or exported. Existing demo credentials are preserved; passwords are needed only when a demo user is missing. The RESPONSIBLE account can manage the catalogue and orders, so choose its password accordingly.

## ID mapping and repeatability

Main uses its existing SERIAL sequences to allocate IDs; it does not assume product IDs 1-8. Categories are identified by the reserved `demo-electronics`, `demo-home-kitchen`, and `demo-office` slugs. Products are identified by their category and exact fixture name. A PostgreSQL advisory transaction lock serializes concurrent runs of this seed because products have no unique SKU column. The fixture SKU appears only in the export, not in the database schema.

Keep those category slugs and product names stable if you want future runs to identify the same demo rows. Existing prices, descriptions, active flags, and quantities are left as they are. If duplicate fixture product names already exist in one demo category, the seed fails and rolls back instead of guessing. A reserved demo email belonging to a different name, gender, or role is also rejected without overwriting or promoting the account.

After Main commits, `--export` writes a credential-free manifest containing the actual product IDs and initial quantities. Inventory reads this file and inserts missing stock with `ON CONFLICT (product_id) DO NOTHING`. Existing quantities may differ from the preview, including after reservations; rerunning does not replenish them. Compare `availableQuantity` with `initialQuantity` in the output.

The two seed transactions are independent. If Inventory fails, fix the issue and rerun it with the same manifest. If export fails after the Main transaction commits, rerun `--verify --export <path>` to recover the manifest. Transfer the export from the same Main environment that the Inventory deployment serves; do not mix IDs from different environments.

## Local commands

Run the existing migrations through your normal process first. These scripts expect the existing schemas and never initialize or synchronize them. Build each project once so its existing `dist/.../data-source.js` is available.

From Main:

```powershell
npm.cmd run build
npm.cmd run seed:demo
# Set DEMO_CUSTOMER_PASSWORD and DEMO_MANAGER_PASSWORD securely in this process.
npm.cmd run seed:demo -- --apply --export demo-inventory.json
npm.cmd run seed:demo -- --verify --export demo-inventory.json
```

From Inventory, using the exported file:

```powershell
npm.cmd run build
npm.cmd run seed:demo -- --preview --manifest ../e-commerce/demo-inventory.json
npm.cmd run seed:demo -- --apply --manifest ../e-commerce/demo-inventory.json
npm.cmd run seed:demo -- --verify --manifest ../e-commerce/demo-inventory.json
```

Use `npm` on Linux. `--verify` connects with a read-only transaction and fails if any required row is missing. It never repairs or resets data.

## Azure: execute manually inside the existing containers

The Main production Compose file names its container `ecommerce-api`. Inventory's `compose.prod.yaml` uses the service name `inventory`, so use Compose instead of assuming a generated container name. Run the commands on the corresponding VMs, from their checked-out repository directories. No command below runs automatically during deployment.

Updated Dockerfiles include these scripts in their runtime images. If you have not rebuilt/deployed the images, you can copy just the scripts into the already running containers without restarting them:

```bash
# Main VM, e-commerce repository
docker cp ./scripts ecommerce-api:/app/

# Inventory VM, inventory-service repository
inventory_container=$(docker compose -f compose.prod.yaml ps -q inventory)
test -n "$inventory_container" || exit 1
docker cp ./scripts/seed-demo.cjs "$inventory_container":/app/scripts/seed-demo.cjs
```

These copies are temporary and disappear when a container is recreated; the updated images make the scripts permanent.

On the **Main VM**, first inspect the offline preview:

```bash
docker exec ecommerce-api node scripts/seed-demo.cjs --preview
```

Choose two passwords without writing their literal values into shell history. In Bash:

```bash
read -rsp 'Demo customer password (12-72 UTF-8 bytes): ' DEMO_CUSTOMER_PASSWORD; printf '\n'
read -rsp 'Demo manager password (12-72 UTF-8 bytes): ' DEMO_MANAGER_PASSWORD; printf '\n'
export DEMO_CUSTOMER_PASSWORD DEMO_MANAGER_PASSWORD

docker exec -e DEMO_CUSTOMER_PASSWORD -e DEMO_MANAGER_PASSWORD ecommerce-api \
  node scripts/seed-demo.cjs --apply --export /tmp/demo-inventory.json

unset DEMO_CUSTOMER_PASSWORD DEMO_MANAGER_PASSWORD
```

Only continue if the apply command succeeds. Verify Main and copy out its manifest:

```bash
docker exec ecommerce-api node scripts/seed-demo.cjs --verify --export /tmp/demo-inventory.json
docker cp ecommerce-api:/tmp/demo-inventory.json ./demo-inventory.json
```

Transfer this file to the **Inventory VM** using your existing SSH account/host or secure copy method:

```bash
# Set these to your actual Inventory VM account and host first.
scp ./demo-inventory.json "${SSH_USER}@${INVENTORY_VM_HOST}:/tmp/demo-inventory.json"
```

On the **Inventory VM**, from the Inventory repository, preview and then explicitly apply:

```bash
docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --preview --manifest - < /tmp/demo-inventory.json

docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --apply --manifest - < /tmp/demo-inventory.json

docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --verify --manifest - < /tmp/demo-inventory.json
```

`-T` allows the manifest to be passed through stdin without allocating a terminal. Each script uses only its own container's DB_* settings, including DB_SSL. No database credentials need to be copied between VMs.

## Verification

1. Main `--verify` must report 3 categories, 8 products, and 2 bcrypt-backed users. Its export is the actual ID mapping.
2. Inventory `--verify` must show exactly those 8 IDs and their current quantities. On a clean demo catalogue, two products have zero stock, three have low stock (5, 3, 2), and three have high stock (120, 80, 200).
3. Run both `--apply` commands again: inserted counts must be zero and IDs unchanged. Existing prices, user hashes, and stock must stay unchanged.
4. Log in through POST /auth/login using a demo email and the password you supplied. GET /products should combine Main catalogue data with Inventory quantities. Zero-stock products remain visible; attempting to order one should return the existing insufficient-stock error.
5. After placing an order for a stocked product, rerun Inventory's seed and verify that the quantity does not return to the fixture's initial value.

For direct SQL checks, use your normal PostgreSQL client separately against each database. Main:

```sql
SELECT c.slug, p.id, p.name, p.price
FROM products p JOIN categories c ON c.id = p.category_id
WHERE c.slug IN ('demo-electronics', 'demo-home-kitchen', 'demo-office')
ORDER BY p.id;

SELECT email, role, "passwordHash" LIKE '$2%' AS uses_bcrypt
FROM users WHERE email IN ('maya.customer@example.com', 'omar.manager@example.com');
```

Inventory, compare the output with the eight IDs from the exported manifest (no cross-database JOIN):

```sql
SELECT product_id, available_quantity FROM inventory_stock ORDER BY product_id;
```

Automated seed checks live in the sibling Inventory repository. `npm run test:demo-seeds` starts a disposable local PostgreSQL cluster with dedicated test databases, runs the real migrations and seed scripts, and stops the cluster afterward. Application environment files are not used for its connections.
