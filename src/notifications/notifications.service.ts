import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { Notification, NotificationType } from './schemas/notification.schema';
import { NotificationRepository } from './repositories/notification.repository';
import { NotificationResponseDto } from './dto/output/notification-response.dto';
import { MarkReadResponseDto } from './dto/output/mark-read-response.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly notificationRepo: NotificationRepository) {}

  async emit(
    type: NotificationType,
    relatedRequestId: Types.ObjectId,
    crn: string,
    ownerId?: string,
    rejectionReason?: string,
  ): Promise<void> {
    try {
      const { recipientId, recipientRole, message } = this.buildPayload(
        type,
        crn,
        ownerId,
        rejectionReason,
      );
      await this.notificationRepo.create({
        recipientId: recipientId ?? null,
        recipientRole,
        type,
        message,
        relatedRequestId,
      });
    } catch (err) {
      this.logger.error(`Failed to emit notification ${type}`, err);
    }
  }

  private buildPayload(
    type: NotificationType,
    crn: string,
    ownerId?: string,
    rejectionReason?: string,
  ): { recipientId: string | null; recipientRole: string; message: string } {
    switch (type) {
      case NotificationType.REQUEST_SUBMITTED:
        return {
          recipientId: null,
          recipientRole: 'backoffice_employee',
          message: `New settlement request submitted for CRN ${crn}.`,
        };
      case NotificationType.REQUEST_APPROVED:
        return {
          recipientId: ownerId ?? null,
          recipientRole: 'owner',
          message:
            'Your settlement request has been approved. Please proceed to payment.',
        };
      case NotificationType.REQUEST_REJECTED:
        return {
          recipientId: ownerId ?? null,
          recipientRole: 'owner',
          message: rejectionReason
            ? `Your settlement request has been rejected. Reason: ${rejectionReason}`
            : 'Your settlement request has been rejected.',
        };
      case NotificationType.PAYMENT_RECEIVED:
        return {
          recipientId: null,
          recipientRole: 'backoffice_employee',
          message: `Payment received for CRN ${crn}. Ready for settlement document upload.`,
        };
      case NotificationType.REQUEST_SETTLED:
        return {
          recipientId: ownerId ?? null,
          recipientRole: 'owner',
          message: 'Your settlement request is now fully settled.',
        };
      default:
        return {
          recipientId: ownerId ?? null,
          recipientRole: 'owner',
          message: `Notification: ${type as string}`,
        };
    }
  }

  async findForOwner(ownerId: string): Promise<NotificationResponseDto[]> {
    const notifications = await this.notificationRepo.findForOwner(ownerId);
    return notifications.map((n) => this.toResponse(n));
  }

  async findForBackoffice(): Promise<NotificationResponseDto[]> {
    const notifications = await this.notificationRepo.findForBackoffice();
    return notifications.map((n) => this.toResponse(n));
  }

  async markAsRead(
    notificationId: string,
    userId: string,
    callerRoles: string[],
  ): Promise<MarkReadResponseDto | 'FORBIDDEN' | null> {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) return null;

    const isBackoffice = callerRoles.includes('backoffice_employee');
    if (notification.recipientRole === 'owner') {
      if (notification.recipientId !== userId) {
        return 'FORBIDDEN';
      }
    } else if (!isBackoffice) {
      return 'FORBIDDEN';
    }

    notification.isRead = true;
    const saved = await this.notificationRepo.save(notification);
    return { id: saved.id, isRead: true };
  }

  private toResponse(notification: Notification): NotificationResponseDto {
    const json = notification.toJSON();
    return {
      ...json,
      relatedRequestId: json.relatedRequestId?.toString(),
    } as NotificationResponseDto;
  }
}
