import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  login!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
