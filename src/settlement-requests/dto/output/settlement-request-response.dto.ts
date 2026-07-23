import { SettlementStatus } from '../../schemas/settlement-request.schema';
import { MeetingResponseDto } from './meeting-response.dto';

export class SettlementRequestResponseDto {
  id: string;
  crn: string;
  ownerId: string;
  status: SettlementStatus;
  meetings: MeetingResponseDto[];
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  paidAt: Date | null;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
