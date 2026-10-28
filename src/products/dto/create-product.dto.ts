import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ProductImageDto } from './product-image.dto';

export const MAX_PRODUCT_IMAGES = 10;
export const MAX_PRODUCT_PRICE = 99999999.99;

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'price must have at most 2 decimal places' },
  )
  @IsPositive()
  @Max(MAX_PRODUCT_PRICE)
  price!: number;

  @IsInt()
  @IsPositive()
  categoryId!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];
}
