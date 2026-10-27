import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { UserResponseDto } from '../../users/dto/user-response.dto';
import type { AuthenticatedRequest } from '../types/authenticated-request';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserResponseDto => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new UnauthorizedException('Authentication required');
    }

    return request.user;
  },
);
