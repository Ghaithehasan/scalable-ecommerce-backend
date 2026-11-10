# Inventory integration

The authoritative contract is `proto/inventory.proto`, mirrored from the sibling Inventory project. Keep both copies identical.
Product metadata/prices remain in Main DB; quantities and reservations are read/written only through gRPC.

- Product responses add `availableQuantity: number | null`. Null means unknown/missing/unreachable, never a fabricated zero. Order placement always reserves atomically even after reading a quantity.
- Send `Idempotency-Key` for every logical checkout and reuse it on HTTP retries. Its identity is scoped to the authenticated user. A changed payload conflicts. Without the optional header, independent HTTP requests can create independent orders.
- New orders persist a reservation UUID and an operation before calling Inventory. Order + lines + COMPLETED commit locally together; RPCs run outside that transaction.
- Failed/unknown reservations and failed local saves enqueue cancellation. The persistent worker retries Release with the same UUID. A timeout does not imply the reservation rolled back.
- Expired PENDING operations are recovered after a crash. Operation-row locking fences late order writers against cancellation; a completed local commit is never blindly compensated.
- Cancelling an order enqueues Release in the same local transaction. Inventory restoration may still be pending if the remote service is unavailable. Inspect `inventory_order_operations`, not only application logs.
- Legacy orders keep a null inventory reservation. Deleting shipped/delivered order history does not return sold items to stock.
- Retain tombstones and deduplication records until a deliberate retention policy accounts for delayed requests.

Run `npm run build`, `npm run migration:run`, `npm run start:dev`. Schema synchronization is disabled in all environments.
For databases previously created with synchronize, reconcile the existing schema/migration history before running the initial migration; never recreate an existing schema blindly.

See `../inventory-service/README.md` for the state table, Docker networking, isolated PostgreSQL tests, and recovery details.
The combined Compose stack lives in `../inventory-service/compose.yaml`; the Inventory port is not published to the host.
The independent existing Main Compose file requires a reachable Inventory endpoint via `INVENTORY_GRPC_URL` when it does not use the combined stack.
