import { IsString, MinLength } from 'class-validator';

export class MobileRefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
