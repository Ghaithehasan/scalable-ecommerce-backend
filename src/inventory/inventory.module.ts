import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InventoryClient } from './inventory.client';
import { InventoryOperationsService } from './inventory-operations.service';

@Module({
  imports: [ConfigModule],
  providers: [InventoryClient, InventoryOperationsService],
  exports: [InventoryClient, InventoryOperationsService],
})
export class InventoryModule {}
