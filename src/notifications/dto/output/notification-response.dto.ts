export class NotificationResponseDto {
  id: string;
  recipientId: string | null;
  recipientRole: string;
  type: string;
  message: string;
  relatedRequestId: string;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}
