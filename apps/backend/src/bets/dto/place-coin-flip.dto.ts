import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PlaceCoinFlipDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  stake!: number;

  @IsString()
  @IsIn(['heads', 'tails'])
  selection!: 'heads' | 'tails';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientSeed?: string;
}
