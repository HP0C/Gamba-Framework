import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// DTOs validate untrusted JSON before a controller method receives it.
export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  // Keep usernames simple for now: letters, numbers, and underscores only.
  @Matches(/^[A-Za-z0-9_]+$/)
  @MinLength(3)
  @MaxLength(30)
  username!: string;

  @IsString()
  // This is only a minimum length rule. Production should add breached-password
  // checks, rate limiting, MFA options, and password reset flows.
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
