import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserResponseDto } from '../../users/dto/user-response.dto';
import { UsersService } from '../../users/users.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AccessTokenPayload } from '../types/access-token-payload';
import type { AuthenticatedRequest } from '../types/authenticated-request';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === 'string'
        ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
        : undefined;

    if (!token) {
      throw new UnauthorizedException('A Bearer access token is required');
    }

    let payload: AccessTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.tokenUse !== 'access' ||
      typeof payload.sub !== 'string' ||
      !/^[1-9]\d*$/.test(payload.sub) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp)
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    const userId = Number(payload.sub);

    if (!Number.isSafeInteger(userId) || userId > 2147483647) {
      throw new UnauthorizedException('Invalid access token');
    }

    // Load current permissions and reject tokens belonging to deleted users.
    // Database failures propagate as server errors instead of becoming a 401.
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Invalid access token');
    }

    request.user = UserResponseDto.fromEntity(user);
    return true;
  }
}
