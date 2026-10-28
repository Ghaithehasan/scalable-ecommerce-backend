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

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserRole } from '../users/enums/user-role.enum';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'List products',
    description:
      'Supports `page`, `limit` and `categoryId`. A RESPONSIBLE user may also ' +
      'pass `isActive`; customers always receive active products only.',
  })
  findAll(
    @Query() query: QueryProductsDto,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<PaginatedResponseDto<ProductResponseDto>> {
    return this.productsService.findAll(query, currentUser);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one product' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<ProductResponseDto> {
    const product = await this.productsService.findOneOrFail(id, currentUser);
    return ProductResponseDto.fromEntity(product);
  }

  @Post()
  @Roles(UserRole.RESPONSIBLE)
  @ApiOperation({
    summary: 'Create a product, optionally with its images (RESPONSIBLE only)',
  })
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    const product = await this.productsService.create(dto);
    return ProductResponseDto.fromEntity(product);
  }

  @Patch(':id')
  @Roles(UserRole.RESPONSIBLE)
  @ApiOperation({
    summary: 'Update a product (RESPONSIBLE only)',
    description: 'Sending `images` replaces the whole image set.',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseDto> {
    const product = await this.productsService.update(id, dto);
    return ProductResponseDto.fromEntity(product);
  }

  @Delete(':id')
  @Roles(UserRole.RESPONSIBLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a product (RESPONSIBLE only)',
    description:
      'Refused with HTTP 409 once the product appears in an order; deactivate ' +
      'it with `isActive: false` instead.',
  })
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.productsService.remove(id);
  }
}
