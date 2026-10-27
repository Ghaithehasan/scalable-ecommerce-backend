import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { QueryFailedError, Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}
  findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository.findOneBy({ email });
  }

  findByEmailForAuthentication(email: string): Promise<UserEntity | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  findAll(): Promise<UserEntity[]> {
    return this.userRepository.find();
  }

  findById(id: number): Promise<UserEntity | null> {
    return this.userRepository.findOneBy({ id });
  }

  async findByIdOrFail(id: number): Promise<UserEntity> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return user;
  }

  async createUser(dto: CreateUserDto): Promise<UserEntity> {
    const existingUser = await this.findByEmail(dto.email);

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = this.userRepository.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      gender: dto.gender,
      passwordHash,
    });

    try {
      return await this.userRepository.save(user);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        'code' in error.driverError &&
        error.driverError.code === '23505'
      ) {
        throw new ConflictException('Email or phone already exists');
      }

      throw error;
    }
  }
}
