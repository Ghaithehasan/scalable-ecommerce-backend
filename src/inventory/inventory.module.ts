import { Global, Module } from '@nestjs/common';

import { InventoryClient } from './inventory.client';

/**
 * The warehouse client, available application-wide.
 *
 * Global because both the catalogue (to show quantities) and orders (to
 * reserve them) need it, and threading the same provider through two feature
 * modules would add nothing.
 */
@Global()
@Module({
  providers: [InventoryClient],
  exports: [InventoryClient],
})
export class InventoryModule {}
