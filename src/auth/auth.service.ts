import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import authConfig from './config/auth.config';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import type { AccessTokenPayload } from './types/access-token-payload';

// A bcrypt comparison is also performed for an unknown email address.
// This hash is a timing fallback, not an account credential or signing key.
const DUMMY_PASSWORD_HASH =
  '$2b$10$mEdkvwKCRQvIS2/d9C4JH.pWyd.9lxhD9IEnD0NJ.2mAwD9roychm';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  async register(dto: CreateUserDto): Promise<AuthResponseDto> {
    const user = await this.usersService.createUser(dto);
    return this.createAuthResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.usersService.findByEmailForAuthentication(
      dto.email,
    );
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.createAuthResponse(user);
  }

  private async createAuthResponse(user: UserEntity): Promise<AuthResponseDto> {
    const payload: AccessTokenPayload = {
      sub: String(user.id),
      tokenUse: 'access',
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSeconds,
      user: UserResponseDto.fromEntity(user),
    };
  }
}
