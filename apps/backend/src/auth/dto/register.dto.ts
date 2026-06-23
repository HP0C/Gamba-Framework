import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_]+$/)
  @MinLength(3)
  @MaxLength(30)
  username!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
