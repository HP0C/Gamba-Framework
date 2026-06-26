import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateBankingMandateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maximumIndividualAmount!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  dailyLimit!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  validDays?: number;
}
