import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ReservationItemEntity } from './entities/reservation-item.entity';
import { ReservationEntity } from './entities/reservation.entity';
import { StockEntity } from './entities/stock.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StockEntity,
      ReservationEntity,
      ReservationItemEntity,
    ]),
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
