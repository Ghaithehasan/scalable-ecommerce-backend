// Must come first: it sets INVENTORY_ARTIFICIAL_DELAY_MS before AppModule is
// loaded. See the comment in that file.
import { ARTIFICIAL_DELAY_MS } from './enable-artificial-delay';

import { status } from '@grpc/grpc-js';

import {
  deleteProducts,
  Harness,
  readStock,
  setStock,
  startHarness,
} from './grpc-test-harness';

/**
 * The "inventory service is slow or unreachable" failure case.
 *
 * INVENTORY_ARTIFICIAL_DELAY_MS makes ReserveStock sleep before it does any
 * work, which is how the live demonstration shows a caller that refuses to
 * wait forever: it sets a deadline, gets DEADLINE_EXCEEDED, and can tell the
 * user something clear instead of hanging.
 *
 * Each test uses its OWN product. That is not tidiness: a gRPC deadline is a
 * client-side give-up, the server keeps working, and an abandoned call landing
 * later would otherwise change the stock a different test is asserting on.
 */
describe('Client deadlines against a slow inventory service', () => {
  let harness: Harness;
  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const PRODUCTS = [
    'deadline-expires',
    'deadline-no-lock',
    'deadline-patient',
    'deadline-compensate',
  ];
  const SHORT_DEADLINE_MS = 300;

  beforeAll(async () => {
    harness = await startHarness();
    for (const product of PRODUCTS) {
      await setStock(harness.dataSource, product, 10);
    }
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await harness.dataSource.query(
        'DELETE FROM reservations WHERE id LIKE $1',
        [`%${RUN}%`],
      );
      await deleteProducts(harness.dataSource, PRODUCTS);
      await harness.close();
    }
  });

  it('returns DEADLINE_EXCEEDED when the caller will not wait', async () => {
    const result = await harness.client.reserveStock(
      `deadline-${RUN}-expires`,
      [{ productId: 'deadline-expires', quantity: 1 }],
      SHORT_DEADLINE_MS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(status.DEADLINE_EXCEEDED);
  });

  it('holds no row lock while it is being slow', async () => {
    const reserve = harness.client.reserveStock(
      `deadline-${RUN}-no-lock`,
      [{ productId: 'deadline-no-lock', quantity: 4 }],
      SHORT_DEADLINE_MS,
    );

    await reserve;

    // The delay runs before the transaction opens, so at the moment the
    // deadline fires nothing has been written and no row is locked.
    expect(await readStock(harness.dataSource, 'deadline-no-lock')).toEqual({
      available: 10,
      reserved: 0,
    });
  });

  it('still succeeds when the caller allows enough time', async () => {
    const result = await harness.client.reserveStock(
      `deadline-${RUN}-patient`,
      [{ productId: 'deadline-patient', quantity: 2 }],
      ARTIFICIAL_DELAY_MS + 5000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reserved).toBe(true);
    expect(await readStock(harness.dataSource, 'deadline-patient')).toEqual({
      available: 8,
      reserved: 2,
    });
  }, 30000);

  /**
   * The reason compensation is not optional.
   *
   * A gRPC deadline only stops the CLIENT waiting; the server has no
   * obligation to abandon the work, and this one does not. So a caller that
   * times out cannot assume nothing happened - the units may well have been
   * reserved a moment later, for an order that will never be placed.
   *
   * The main application must therefore send ReleaseStock for the same
   * reservation id after any failed reserve, which is exactly what the
   * tombstone and the idempotency rules are built to make safe.
   */
  it('reserves anyway after the client gave up, which is why compensation is required', async () => {
    const reservationId = `deadline-${RUN}-compensate`;
    const product = 'deadline-compensate';

    const abandoned = await harness.client.reserveStock(
      reservationId,
      [{ productId: product, quantity: 3 }],
      SHORT_DEADLINE_MS,
    );
    expect(abandoned.ok).toBe(false);
    if (abandoned.ok) return;
    expect(abandoned.code).toBe(status.DEADLINE_EXCEEDED);

    // Give the server time to finish the work the client walked away from.
    await new Promise((resolve) =>
      setTimeout(resolve, ARTIFICIAL_DELAY_MS + 1500),
    );

    expect(await readStock(harness.dataSource, product)).toEqual({
      available: 7,
      reserved: 3,
    });

    // Compensating with the same id puts it right.
    const released = await harness.client.releaseStock(reservationId);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released).toBe(true);

    expect(await readStock(harness.dataSource, product)).toEqual({
      available: 10,
      reserved: 0,
    });
  }, 30000);
});
