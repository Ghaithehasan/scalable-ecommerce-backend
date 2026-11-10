// Manual demo provisioning only. No application bootstrap, migrations, or schema sync.
const { writeFileSync } = require("node:fs");
const bcrypt = require("bcrypt");
const data = require("./demo-data.json");

function options(argv) {
  let mode = "preview";
  let explicitMode = false;
  let exportPath;
  for (let i = 0; i < argv.length; i++) {
    if (["--preview", "--apply", "--verify"].includes(argv[i])) {
      if (explicitMode)
        throw new Error("Choose only one of --preview, --apply, --verify");
      mode = argv[i].slice(2);
      explicitMode = true;
    } else if (
      argv[i] === "--export" &&
      !exportPath &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("--")
    ) {
      exportPath = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    }
  }
  if (mode === "preview" && exportPath)
    throw new Error(
      "Export IDs with --apply or --verify; preview does not connect to a database",
    );
  return { mode, exportPath };
}

function password(value, name) {
  const size = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
  if (size < 12 || size > 72)
    throw new Error(
      `${name} must contain 12-72 UTF-8 bytes (required for a missing demo user)`,
    );
  return value;
}

function assertDemoUser(user, fixture) {
  // Never promote or overwrite an unrelated account that uses a reserved demo email.
  if (
    user.name !== fixture.name ||
    user.gender !== fixture.gender ||
    user.role !== fixture.role
  ) {
    throw new Error(
      `Demo email collision: ${fixture.email}; the existing account was not modified`,
    );
  }
  if (
    !/^\$2[aby]\$\d\d\$/.test(user.passwordHash) ||
    bcrypt.getRounds(user.passwordHash) < 10
  ) {
    throw new Error(
      `Existing demo account does not have a supported bcrypt hash: ${fixture.email}`,
    );
  }
}

async function category(manager, slug) {
  const [row] = await manager.query(
    "SELECT id, name FROM categories WHERE slug = $1",
    [slug],
  );
  if (!row) throw new Error(`Missing demo category: ${slug}`);
  const fixture = data.categories.find((item) => item.slug === slug);
  if (!fixture || row.name !== fixture.name)
    throw new Error(
      `Demo category slug collision: ${slug}; the existing category was not modified`,
    );
  return row;
}

async function product(manager, fixture, categoryId) {
  const rows = await manager.query(
    "SELECT id, name, price FROM products WHERE category_id = $1 AND name = $2 ORDER BY id",
    [categoryId, fixture.name],
  );
  if (rows.length > 1)
    throw new Error(
      `Ambiguous demo product: ${fixture.name}; resolve existing duplicates manually`,
    );
  return rows[0];
}

async function user(manager, fixture) {
  const [row] = await manager.query(
    'SELECT id, name, email, gender, role, "passwordHash" FROM users WHERE email = $1',
    [fixture.email],
  );
  if (row) assertDemoUser(row, fixture);
  return row;
}

async function collect(manager) {
  const products = [];
  for (const fixture of data.products) {
    const parent = await category(manager, fixture.category);
    const row = await product(manager, fixture, parent.id);
    if (!row) throw new Error(`Missing demo product: ${fixture.name}`);
    products.push({
      sku: fixture.sku,
      name: row.name,
      productId: String(row.id),
      initialQuantity: fixture.initialQuantity,
    });
  }
  const users = [];
  for (const fixture of data.users) {
    const row = await user(manager, fixture);
    if (!row) throw new Error(`Missing demo user: ${fixture.email}`);
    users.push({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
    });
  }
  return { manifest: { dataset: data.dataset, products }, users };
}

async function seedDemo(dataSource, env = process.env) {
  return dataSource.transaction(async (manager) => {
    // Products have no unique SKU/name column. Serialize cooperating seed runs
    // without adding a new table or changing the application's schema.
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      data.dataset,
    ]);
    const inserted = { categories: 0, products: 0, users: 0 };
    for (const fixture of data.categories) {
      const rows = await manager.query(
        `INSERT INTO categories (name, slug, description, is_active)
         VALUES ($1, $2, $3, true) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [fixture.name, fixture.slug, fixture.description],
      );
      inserted.categories += rows.length;
      await category(manager, fixture.slug);
    }
    for (const fixture of data.products) {
      const parent = await category(manager, fixture.category);
      if (await product(manager, fixture, parent.id)) continue;
      await manager.query(
        `INSERT INTO products (name, description, price, category_id, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [fixture.name, fixture.description, fixture.price, parent.id],
      );
      inserted.products++;
    }
    for (const fixture of data.users) {
      if (await user(manager, fixture)) continue;
      const hash = await bcrypt.hash(
        password(env[fixture.passwordEnv], fixture.passwordEnv),
        12,
      );
      const rows = await manager.query(
        `INSERT INTO users (name, email, phone, gender, "passwordHash", role)
         VALUES ($1, $2, NULL, $3, $4, $5) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [fixture.name, fixture.email, fixture.gender, hash, fixture.role],
      );
      inserted.users += rows.length;
      // Recheck identity if another process registered the email concurrently.
      await user(manager, fixture);
    }
    return { ...(await collect(manager)), inserted };
  });
}

async function verifyDemo(dataSource) {
  return dataSource.transaction("REPEATABLE READ", async (manager) => {
    await manager.query("SET TRANSACTION READ ONLY");
    return collect(manager);
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.mode === "preview") {
    console.log(
      "Preview only: no database connection. Product IDs will be assigned by the Main database.",
    );
    console.table(data.categories.map(({ name, slug }) => ({ name, slug })));
    console.table(
      data.products.map(({ sku, category, name, price, initialQuantity }) => ({
        sku,
        category,
        name,
        price,
        initialQuantity,
      })),
    );
    console.table(
      data.users.map(({ name, email, role }) => ({ name, email, role })),
    );
    console.log(
      "New users require DEMO_CUSTOMER_PASSWORD and DEMO_MANAGER_PASSWORD; passwords are never printed or reset.",
    );
    return;
  }
  require("dotenv/config");
  const { default: dataSource } = require("../dist/data-source");
  await dataSource.initialize();
  try {
    const result =
      args.mode === "apply"
        ? await seedDemo(dataSource)
        : await verifyDemo(dataSource);
    if (args.exportPath) {
      writeFileSync(
        args.exportPath,
        `${JSON.stringify(result.manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(
        `Inventory ID/stock manifest exported to ${args.exportPath} (no credentials).`,
      );
    }
    if (result.inserted)
      console.log(
        "Inserted:",
        result.inserted,
        "; existing rows and credentials were preserved.",
      );
    else
      console.log(
        "Verified 3 demo categories, 8 demo products, and 2 bcrypt-backed demo users.",
      );
    console.table(result.manifest.products);
    console.table(result.users);
  } finally {
    await dataSource.destroy();
  }
}

module.exports = { seedDemo, verifyDemo, options };
if (require.main === module)
  main().catch((error) => {
    console.error(`Demo seed failed: ${error.message}`);
    process.exitCode = 1;
  });
