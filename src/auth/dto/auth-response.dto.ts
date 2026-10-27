import { UserResponseDto } from '../../users/dto/user-response.dto';

export class AuthResponseDto {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: UserResponseDto;
}
