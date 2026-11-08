import {
  deleteProducts,
  Harness,
  readStock,
  setStock,
  startHarness,
} from './grpc-test-harness';

/**
 * The proof the requirement asks for: many simultaneous orders for the last
 * unit, exactly one of which may succeed.
 *
 * The whole concurrency design rests on this, so the scenario is repeated
 * several times: a race that passes once may simply have been lucky with
 * scheduling, and an intermittently-correct lock is not correct.
 */
describe('ReserveStock under concurrency', () => {
  let harness: Harness;
  const PRODUCT = 'race-last-unit';
  const SECOND_PRODUCT = 'race-second';
  const CONCURRENCY = 50;
  const ROUNDS = 5;

  // Reservation ids must be unique PER RUN. Fixed ids would be replayed by the
  // idempotency rule on a second run against the same database: the previous
  // winner's reservation still exists, so it correctly answers reserved=true
  // without touching stock, and the round would then count two winners. That
  // is the service behaving properly and the fixture lying.
  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    harness = await startHarness();
  }, 60000);

  afterAll(async () => {
    if (harness) {
      // Reservations cascade to their items, so one delete is enough.
      await harness.dataSource.query(
        'DELETE FROM reservations WHERE id LIKE $1',
        [`%${RUN}%`],
      );
      await deleteProducts(harness.dataSource, [PRODUCT, SECOND_PRODUCT]);
      await harness.close();
    }
  });

  it.each(Array.from({ length: ROUNDS }, (_, index) => index + 1))(
    'round %i: exactly one of 50 simultaneous reservations wins the last unit',
    async (round) => {
      await setStock(harness.dataSource, PRODUCT, 1);

      const attempts = Array.from({ length: CONCURRENCY }, (_, index) =>
        harness.client.reserveStock(`race-${RUN}-${round}-${index}`, [
          { productId: PRODUCT, quantity: 1 },
        ]),
      );

      const results = await Promise.all(attempts);

      const errors = results.filter((result) => !result.ok);
      const granted = results.filter(
        (result) => result.ok && result.value.reserved,
      );
      const refused = results.filter(
        (result) => result.ok && !result.value.reserved,
      );

      // No call may fail technically: running out of stock is an answer, not
      // an error, and a deadlock or timeout would show up here.
      expect(errors).toHaveLength(0);
      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(CONCURRENCY - 1);

      // Every refusal must explain itself.
      for (const result of refused) {
        if (!result.ok) continue;
        expect(result.value.shortages).toEqual([
          { productId: PRODUCT, requested: 1, available: 0 },
        ]);
      }

      // The ledger balances: the unit moved, it was not duplicated or lost.
      expect(await readStock(harness.dataSource, PRODUCT)).toEqual({
        available: 0,
        reserved: 1,
      });
    },
    120000,
  );

  it('never oversells when many orders take several units each', async () => {
    await setStock(harness.dataSource, PRODUCT, 10);

    const attempts = Array.from({ length: 20 }, (_, index) =>
      harness.client.reserveStock(`bulk-${RUN}-${index}`, [
        { productId: PRODUCT, quantity: 3 },
      ]),
    );

    const results = await Promise.all(attempts);
    const granted = results.filter(
      (result) => result.ok && result.value.reserved,
    ).length;

    // 10 units, 3 per order: at most 3 orders can be satisfied.
    expect(granted).toBe(3);

    const stock = await readStock(harness.dataSource, PRODUCT);
    expect(stock).toEqual({ available: 1, reserved: 9 });
  }, 120000);

  it('keeps two products consistent when orders list them in opposite order', async () => {
    // The deadlock scenario: without a consistent lock order these two groups
    // would each hold the row the other needs.
    await setStock(harness.dataSource, PRODUCT, 20);
    await setStock(harness.dataSource, SECOND_PRODUCT, 20);

    const forward = Array.from({ length: 15 }, (_, index) =>
      harness.client.reserveStock(`fwd-${RUN}-${index}`, [
        { productId: PRODUCT, quantity: 1 },
        { productId: SECOND_PRODUCT, quantity: 1 },
      ]),
    );
    const backward = Array.from({ length: 15 }, (_, index) =>
      harness.client.reserveStock(`bwd-${RUN}-${index}`, [
        { productId: SECOND_PRODUCT, quantity: 1 },
        { productId: PRODUCT, quantity: 1 },
      ]),
    );

    const results = await Promise.all([...forward, ...backward]);

    expect(results.filter((result) => !result.ok)).toHaveLength(0);

    const granted = results.filter(
      (result) => result.ok && result.value.reserved,
    ).length;
    expect(granted).toBe(20);

    expect(await readStock(harness.dataSource, PRODUCT)).toEqual({
      available: 0,
      reserved: 20,
    });
    expect(await readStock(harness.dataSource, SECOND_PRODUCT)).toEqual({
      available: 0,
      reserved: 20,
    });
  }, 120000);
});
