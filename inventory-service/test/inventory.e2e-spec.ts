import { status } from '@grpc/grpc-js';

import {
  deleteProducts,
  Harness,
  readStock,
  setStock,
  startHarness,
} from './grpc-test-harness';

/**
 * Behaviour of the three RPCs, exercised through a real gRPC client against a
 * real PostgreSQL database.
 */
describe('InventoryService over gRPC', () => {
  let harness: Harness;
  const products = ['t-plenty', 't-scarce', 't-empty', 't-other'];

  const id = (name: string): string =>
    `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    harness = await startHarness();
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await deleteProducts(harness.dataSource, products);
      await harness.close();
    }
  });

  beforeEach(async () => {
    await setStock(harness.dataSource, 't-plenty', 100);
    await setStock(harness.dataSource, 't-scarce', 2);
    await setStock(harness.dataSource, 't-empty', 0);
    await setStock(harness.dataSource, 't-other', 10);
  });

  describe('GetStock', () => {
    it('returns the requested products', async () => {
      const result = await harness.client.getStock(['t-plenty', 't-scarce']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items).toEqual([
        { productId: 't-plenty', available: 100, reserved: 0 },
        { productId: 't-scarce', available: 2, reserved: 0 },
      ]);
    });

    it('omits unknown ids instead of failing', async () => {
      const result = await harness.client.getStock([
        't-plenty',
        'does-not-exist',
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((item) => item.productId)).toEqual([
        't-plenty',
      ]);
    });

    it('accepts an empty list', async () => {
      const result = await harness.client.getStock([]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items).toEqual([]);
    });
  });

  describe('ReserveStock', () => {
    it('moves units from available to reserved', async () => {
      const result = await harness.client.reserveStock(id('ok'), [
        { productId: 't-plenty', quantity: 3 },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ reserved: true, shortages: [] });
      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 97,
        reserved: 3,
      });
    });

    it('reports a shortage as a response rather than an error', async () => {
      const result = await harness.client.reserveStock(id('short'), [
        { productId: 't-scarce', quantity: 5 },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.reserved).toBe(false);
      expect(result.value.shortages).toEqual([
        { productId: 't-scarce', requested: 5, available: 2 },
      ]);
      expect(await readStock(harness.dataSource, 't-scarce')).toEqual({
        available: 2,
        reserved: 0,
      });
    });

    it('is all-or-nothing: a sufficient item is rolled back with a short one', async () => {
      const result = await harness.client.reserveStock(id('mixed'), [
        { productId: 't-plenty', quantity: 1 },
        { productId: 't-scarce', quantity: 99 },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.reserved).toBe(false);
      expect(result.value.shortages).toEqual([
        { productId: 't-scarce', requested: 99, available: 2 },
      ]);
      // The sufficient item must be untouched.
      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 100,
        reserved: 0,
      });
    });

    it('lists every shortage, not only the first', async () => {
      const result = await harness.client.reserveStock(id('many'), [
        { productId: 't-scarce', quantity: 50 },
        { productId: 't-empty', quantity: 1 },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.reserved).toBe(false);
      expect(
        [...result.value.shortages].sort((a, b) =>
          a.productId.localeCompare(b.productId),
        ),
      ).toEqual([
        { productId: 't-empty', requested: 1, available: 0 },
        { productId: 't-scarce', requested: 50, available: 2 },
      ]);
    });

    it('reserves only once for a repeated reservation id', async () => {
      const reservationId = id('idem');

      const first = await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 4 },
      ]);
      const second = await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 4 },
      ]);

      expect(first.ok && first.value.reserved).toBe(true);
      expect(second.ok && second.value.reserved).toBe(true);
      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 96,
        reserved: 4,
      });
    });

    it('rejects an unknown product with NOT_FOUND', async () => {
      const result = await harness.client.reserveStock(id('unknown'), [
        { productId: 'no-such-product', quantity: 1 },
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(status.NOT_FOUND);
    });

    it('does not touch stock when one item is unknown', async () => {
      await harness.client.reserveStock(id('unknown-mixed'), [
        { productId: 't-plenty', quantity: 1 },
        { productId: 'no-such-product', quantity: 1 },
      ]);

      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 100,
        reserved: 0,
      });
    });

    it.each([
      ['an empty reservation id', '', [{ productId: 't-plenty', quantity: 1 }]],
      ['no items', id('empty'), []],
      [
        'a zero quantity',
        id('zero'),
        [{ productId: 't-plenty', quantity: 0 }],
      ],
      [
        'a negative quantity',
        id('negative'),
        [{ productId: 't-plenty', quantity: -3 }],
      ],
      [
        'the same product twice',
        id('dup'),
        [
          { productId: 't-plenty', quantity: 1 },
          { productId: 't-plenty', quantity: 2 },
        ],
      ],
    ])('rejects %s with INVALID_ARGUMENT', async (_name, reservationId, items) => {
      const result = await harness.client.reserveStock(reservationId, items);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(status.INVALID_ARGUMENT);
    });
  });

  describe('ReleaseStock', () => {
    it('returns the units and is idempotent', async () => {
      const reservationId = id('release');
      await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 6 },
      ]);

      const first = await harness.client.releaseStock(reservationId);
      const second = await harness.client.releaseStock(reservationId);

      expect(first.ok && first.value.released).toBe(true);
      expect(second.ok && second.value.released).toBe(true);
      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 100,
        reserved: 0,
      });
    });

    it('writes a tombstone for an unknown id so a late reserve is refused', async () => {
      const reservationId = id('tombstone');

      const released = await harness.client.releaseStock(reservationId);
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      // Nothing was actually given back, and the caller is told so.
      expect(released.value.released).toBe(false);

      const late = await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 1 },
      ]);

      expect(late.ok).toBe(false);
      if (late.ok) return;
      expect(late.code).toBe(status.FAILED_PRECONDITION);
      expect(await readStock(harness.dataSource, 't-plenty')).toEqual({
        available: 100,
        reserved: 0,
      });
    });

    it('refuses to reserve a reservation that was released normally', async () => {
      const reservationId = id('reuse');
      await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 1 },
      ]);
      await harness.client.releaseStock(reservationId);

      const again = await harness.client.reserveStock(reservationId, [
        { productId: 't-plenty', quantity: 1 },
      ]);

      expect(again.ok).toBe(false);
      if (again.ok) return;
      expect(again.code).toBe(status.FAILED_PRECONDITION);
    });

    it('rejects an empty reservation id with INVALID_ARGUMENT', async () => {
      const result = await harness.client.releaseStock('');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(status.INVALID_ARGUMENT);
    });
  });
});
