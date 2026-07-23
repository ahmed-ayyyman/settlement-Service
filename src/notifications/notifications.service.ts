import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationType } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
  ) {}

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
      await this.notificationModel.create({
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
          message: `Notification: ${type}`,
        };
    }
  }

  async findForOwner(ownerId: string): Promise<Notification[]> {
    return this.notificationModel
      .find({ recipientRole: 'owner', recipientId: ownerId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findForBackoffice(): Promise<Notification[]> {
    return this.notificationModel
      .find({ recipientRole: 'backoffice_employee' })
      .sort({ createdAt: -1 })
      .exec();
  }

  async markAsRead(
    notificationId: string,
    userId: string,
    callerRoles: string[],
  ): Promise<{ id: string; isRead: boolean } | 'FORBIDDEN' | null> {
    if (!Types.ObjectId.isValid(notificationId)) {
      return null;
    }
    const notification = await this.notificationModel
      .findById(notificationId)
      .exec();
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
    const saved = await notification.save();
    return { id: saved.id, isRead: true };
  }
}
