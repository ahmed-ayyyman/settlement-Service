import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;
}
