import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsPositive,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const MAX_ORDER_LINES = 50;
export const MAX_LINE_QUANTITY = 1000;

export class CreateOrderItemDto {
  @IsInt()
  @IsPositive()
  productId!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

/**
 * An order is placed with product references and quantities only. Prices are
 * read from the catalogue by the server, so a client cannot choose what it
 * pays.
 */
export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'An order must contain at least one item' })
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}
