import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { UsersService } from './users.service';
import { UserResponseDto } from './dto/user-response.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from './enums/user-role.enum';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(UserRole.RESPONSIBLE)
  async findAllUsers(): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll();
    return users.map((user) => UserResponseDto.fromEntity(user));
  }

  @Get(':id')
  async findOneUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: UserResponseDto,
  ): Promise<UserResponseDto> {
    if (currentUser.id !== id && currentUser.role !== UserRole.RESPONSIBLE) {
      throw new ForbiddenException('You cannot access another user');
    }

    const user = await this.usersService.findByIdOrFail(id);
    return UserResponseDto.fromEntity(user);
  }

  @Post()
  @Roles(UserRole.RESPONSIBLE)
  async createUser(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    const user = await this.usersService.createUser(dto);
    return UserResponseDto.fromEntity(user);
  }
}
