import { IsNumber, Min } from 'class-validator';

export class SetFeeDto {
  @IsNumber()
  @Min(0)
  fee: number;
}
