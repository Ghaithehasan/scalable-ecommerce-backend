import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsPositive } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { toOptionalBoolean } from './transform-helpers';

export class QueryProductsDto extends PaginationQueryDto {
  /** Restricts the page to one category. Filtering happens in SQL. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'categoryId must be an integer' })
  @IsPositive()
  categoryId?: number;

  /**
   * Only a RESPONSIBLE user may change this; customers always receive active
   * products regardless of what they send.
   */
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean({ message: 'isActive must be true or false' })
  isActive?: boolean;
}
