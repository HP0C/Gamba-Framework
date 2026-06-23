import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PlaceRouletteDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  stake!: number;

  @IsString()
  @IsIn(['number', 'colour'])
  betType!: 'number' | 'colour';

  @IsString()
  @MaxLength(16)
  selection!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientSeed?: string;
}
