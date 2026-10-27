import {
  IsByteLength,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { UserGender } from '../enums/gender.enum';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'Phone number must be a valid phone number',
  })
  phone?: string | null;

  @IsEnum(UserGender)
  gender!: UserGender;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @IsByteLength(0, 72, {
    message: 'Password must not exceed 72 UTF-8 bytes',
  })
  password!: string;
}
