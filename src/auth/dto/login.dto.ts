import {
  IsByteLength,
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @IsByteLength(0, 72, {
    message: 'Password must not exceed 72 UTF-8 bytes',
  })
  password!: string;
}
