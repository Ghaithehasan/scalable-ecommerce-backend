import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { OrderStatus } from '../enums/order-status.enum';

export class QueryOrdersDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus, {
    message: `status must be one of: ${Object.values(OrderStatus).join(', ')}`,
  })
  status?: OrderStatus;

  /**
   * Only a RESPONSIBLE user may read another customer's orders. A customer
   * that asks for a different `userId` is refused rather than quietly given
   * their own orders.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'userId must be an integer' })
  @IsPositive()
  userId?: number;
}
