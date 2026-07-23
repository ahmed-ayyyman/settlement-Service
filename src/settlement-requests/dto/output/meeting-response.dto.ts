export class MeetingResponseDto {
  _id: string;
  meetingDate: Date;
  capitalAtMeeting: number;
  attachmentUrl: string;
  attachmentOriginalName?: string;
  attachmentMimeType?: string;
  fee: number | null;
  settlementDocumentUrl: string | null;
  settlementDocumentUploadedAt: Date | null;
}
