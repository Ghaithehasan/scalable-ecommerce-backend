import type { Request } from 'express';
import type { UserResponseDto } from '../../users/dto/user-response.dto';

export interface AuthenticatedRequest extends Request {
  user?: UserResponseDto;
}
