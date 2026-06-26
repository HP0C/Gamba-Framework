import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class CreateMandateDepositDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsUUID()
  mandateId?: string;

  @IsOptional()
  @IsUUID()
  sourceTransactionId?: string;
}
