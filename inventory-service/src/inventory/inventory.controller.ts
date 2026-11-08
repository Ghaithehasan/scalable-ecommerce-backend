import { Controller } from '@nestjs/common';
import { Payload } from '@nestjs/microservices';

import {
  GetStockResponse,
  InventoryServiceController,
  InventoryServiceControllerMethods,
  ReleaseStockResponse,
  ReserveStockResponse,
} from '../generated/inventory/v1/inventory';
import {
  GetStockRequestDto,
  ReleaseStockRequestDto,
  ReserveStockRequestDto,
} from './dto/inventory-request.dto';
import { InventoryService } from './inventory.service';

/**
 * Transport layer only: it declares the three RPCs and hands the payload to
 * the service. No business logic lives here.
 *
 * Two decorators are doing distinct jobs:
 *   @InventoryServiceControllerMethods() is generated from the contract and
 *   registers every RPC with Nest, so a method renamed here stops compiling.
 *
 *   @Payload() marks the argument. It is also what makes TypeScript emit
 *   design:paramtypes for these methods: without a parameter or method
 *   decorator in the source, that metadata is never emitted, the global
 *   ValidationPipe receives no metatype and silently validates nothing.
 */
@Controller()
@InventoryServiceControllerMethods()
export class InventoryController implements InventoryServiceController {
  constructor(private readonly inventoryService: InventoryService) {}

  getStock(@Payload() request: GetStockRequestDto): Promise<GetStockResponse> {
    return this.inventoryService.getStock(request);
  }

  reserveStock(
    @Payload() request: ReserveStockRequestDto,
  ): Promise<ReserveStockResponse> {
    return this.inventoryService.reserveStock(request);
  }

  releaseStock(
    @Payload() request: ReleaseStockRequestDto,
  ): Promise<ReleaseStockResponse> {
    return this.inventoryService.releaseStock(request);
  }
}
