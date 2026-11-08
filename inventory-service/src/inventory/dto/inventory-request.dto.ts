import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import type {
  GetStockRequest,
  ReleaseStockRequest,
  ReserveItem,
  ReserveStockRequest,
} from '../../generated/inventory/v1/inventory';

/**
 * Request classes mirroring the generated proto interfaces.
 *
 * ts-proto emits plain interfaces, which carry no runtime metadata, so they
 * cannot be validated. These classes implement those interfaces - the compiler
 * fails if the shapes ever drift apart - and add the constraints the contract
 * documents.
 */

export const MAX_PRODUCT_ID_LENGTH = 64;
export const MAX_RESERVATION_ID_LENGTH = 128;
export const MAX_ITEMS_PER_RESERVATION = 100;
export const MAX_PRODUCTS_PER_QUERY = 500;
export const MAX_QUANTITY = 1_000_000;

export class GetStockRequestDto implements GetStockRequest {
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCTS_PER_QUERY)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(MAX_PRODUCT_ID_LENGTH, { each: true })
  productIds: string[] = [];
}

export class ReserveItemDto implements ReserveItem {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PRODUCT_ID_LENGTH)
  productId: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MAX_QUANTITY)
  quantity: number;
}

export class ReserveStockRequestDto implements ReserveStockRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_RESERVATION_ID_LENGTH)
  reservationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS_PER_RESERVATION)
  @ValidateNested({ each: true })
  @Type(() => ReserveItemDto)
  items: ReserveItemDto[];
}

export class ReleaseStockRequestDto implements ReleaseStockRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_RESERVATION_ID_LENGTH)
  reservationId: string;
}
