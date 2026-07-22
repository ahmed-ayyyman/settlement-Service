import { ArrayMinSize, IsArray, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MeetingInputDto } from './meeting-input.dto';

export class CreateSettlementRequestDto {
  @IsString()
  crn: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one meeting is required' })
  @ValidateNested({ each: true })
  @Type(() => MeetingInputDto)
  meetings: MeetingInputDto[];
}
