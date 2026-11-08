/**
 * Seeds the inventory database with starting stock levels.
 *
 * The product ids are FIXED STRINGS and are written here by hand on purpose.
 * Reading them from the main application's database would couple the two
 * services at the storage layer and destroy the database-per-service boundary
 * this whole requirement exists to establish. The main application has no seed
 * of its own (checked), so "1".."8" are used, matching the ids PostgreSQL
 * hands out to the first eight products created through POST /products.
 *
 * Product "1" deliberately holds a single unit: it is the subject of the race
 * demonstration, where many simultaneous orders compete for the last one.
 *
 * Running this twice is safe - it upserts - so it can be part of container
 * start-up without guarding against a second run.
 *
 * It lives under src/ rather than scripts/ so that `nest build` compiles it:
 * the production image carries no TypeScript toolchain, and the container
 * seeds itself with `node dist/database/seed.js`.
 */
import dataSource from './data-source';
import { StockEntity } from '../inventory/entities/stock.entity';

interface SeedRow {
  productId: string;
  available: number;
  note: string;
}

export const SEED_ROWS: SeedRow[] = [
  { productId: '1', available: 1, note: 'last unit - used by the race demo' },
  { productId: '2', available: 5, note: 'small stock' },
  { productId: '3', available: 10, note: '' },
  { productId: '4', available: 25, note: '' },
  { productId: '5', available: 50, note: '' },
  { productId: '6', available: 100, note: '' },
  { productId: '7', available: 0, note: 'out of stock - shortage scenarios' },
  { productId: '8', available: 7, note: '' },
];

export async function seed(): Promise<void> {
  const repository = dataSource.getRepository(StockEntity);

  await repository.upsert(
    SEED_ROWS.map((row) => ({
      productId: row.productId,
      available: row.available,
      reserved: 0,
    })),
    { conflictPaths: ['productId'], skipUpdateIfNoValuesChanged: false },
  );
}

async function main(): Promise<void> {
  await dataSource.initialize();

  try {
    await seed();

    const rows = await dataSource
      .getRepository(StockEntity)
      .find({ order: { productId: 'ASC' } });

    console.log('\n  product_id   available   reserved');
    console.log('  ----------   ---------   --------');
    for (const row of rows) {
      console.log(
        `  ${row.productId.padEnd(12)} ${String(row.available).padEnd(11)} ${row.reserved}`,
      );
    }
    console.log(`\n  ${rows.length} stock rows present.\n`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error('SEED FAILED:', error);
    process.exit(1);
  });
}
