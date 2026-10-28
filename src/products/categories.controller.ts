import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { CategoriesService } from './categories.service';
import { CategoryResponseDto } from './dto/category-response.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List categories (paginated)' })
  findAll(
    @Query() query: QueryCategoriesDto,
  ): Promise<PaginatedResponseDto<CategoryResponseDto>> {
    return this.categoriesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one category' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.findByIdOrFail(id);
    return CategoryResponseDto.fromEntity(category);
  }

  @Post()
  @Roles(UserRole.RESPONSIBLE)
  @ApiOperation({ summary: 'Create a category (RESPONSIBLE only)' })
  async create(
    @Body() dto: CreateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.create(dto);
    return CategoryResponseDto.fromEntity(category);
  }

  @Patch(':id')
  @Roles(UserRole.RESPONSIBLE)
  @ApiOperation({ summary: 'Update a category (RESPONSIBLE only)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.update(id, dto);
    return CategoryResponseDto.fromEntity(category);
  }

  @Delete(':id')
  @Roles(UserRole.RESPONSIBLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a category (RESPONSIBLE only)',
    description:
      'Refused with HTTP 409 while products are still classified under it.',
  })
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.categoriesService.remove(id);
  }
}
