import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { toOptionalBoolean } from './transform-helpers';

export class QueryCategoriesDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean({ message: 'isActive must be true or false' })
  isActive?: boolean;
}
