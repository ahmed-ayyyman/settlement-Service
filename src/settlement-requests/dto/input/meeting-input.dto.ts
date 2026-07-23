import { IsDateString, IsNumber, IsPositive } from 'class-validator';

export class MeetingInputDto {
  @IsDateString()
  meetingDate: string;

  @IsNumber()
  @IsPositive()
  capitalAtMeeting: number;
}
