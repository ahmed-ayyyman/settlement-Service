import { SettlementStatus } from '../../schemas/settlement-request.schema';

export class UploadSettlementDocumentResponseDto {
  status: SettlementStatus;
  meetingId: string;
}
