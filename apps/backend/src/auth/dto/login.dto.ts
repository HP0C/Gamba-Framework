import { IsString, MaxLength, MinLength } from 'class-validator';

// Login accepts either username or email in the same field.
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
