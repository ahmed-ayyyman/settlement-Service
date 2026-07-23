import { NotificationResponseDto } from './notification-response.dto';

export class NotificationsListResponseDto {
  notifications: NotificationResponseDto[];
  unreadCount: number;
}
