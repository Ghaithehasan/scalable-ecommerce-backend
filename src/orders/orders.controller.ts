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
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({
    summary: 'Place an order for the authenticated user',
    description:
      'Line prices are taken from the catalogue, not from the request body.',
  })
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<OrderResponseDto> {
    const order = await this.ordersService.create(dto, currentUser);
    return OrderResponseDto.fromEntity(order);
  }

  @Get()
  @ApiOperation({
    summary: 'List orders',
    description:
      'A customer receives only their own orders. A RESPONSIBLE user receives ' +
      'every order and may narrow the list with `userId`. Also supports ' +
      '`status`, `page` and `limit`.',
  })
  findAll(
    @Query() query: QueryOrdersDto,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    return this.ordersService.findAll(query, currentUser);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one order',
    description:
      'Reading an order that belongs to another user returns HTTP 403.',
  })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<OrderResponseDto> {
    const order = await this.ordersService.findOneOrFail(id, currentUser);
    return OrderResponseDto.fromEntity(order);
  }

  @Patch(':id/status')
  @Roles(UserRole.RESPONSIBLE)
  @ApiOperation({
    summary: 'Change the status of an order (RESPONSIBLE only)',
    description:
      'PENDING to CONFIRMED or CANCELLED, CONFIRMED to SHIPPED or CANCELLED, ' +
      'SHIPPED to DELIVERED. Any other move returns HTTP 409.',
  })
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<OrderResponseDto> {
    const order = await this.ordersService.updateStatus(id, dto);
    return OrderResponseDto.fromEntity(order);
  }

  @Delete(':id')
  @Roles(UserRole.RESPONSIBLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an order and its lines (RESPONSIBLE only)',
  })
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.ordersService.remove(id);
  }
}
