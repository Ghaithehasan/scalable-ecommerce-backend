import type { UserEntity } from '../entities/user.entity';
import { UserGender } from '../enums/gender.enum';
import { UserRole } from '../enums/user-role.enum';

export class UserResponseDto {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  gender: UserGender;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(user: UserEntity): UserResponseDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      gender: user.gender,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
