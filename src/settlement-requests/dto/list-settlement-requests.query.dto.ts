import { IsEnum, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { SettlementStatus } from '../schemas/settlement-request.schema';

export class ListSettlementRequestsQueryDto {
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
