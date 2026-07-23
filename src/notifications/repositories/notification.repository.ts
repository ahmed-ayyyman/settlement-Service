import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification } from '../schemas/notification.schema';

@Injectable()
export class NotificationRepository {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
  ) {}

  async create(data: Partial<Notification>): Promise<Notification> {
    return this.notificationModel.create(data);
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

  async findById(id: string): Promise<Notification | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.notificationModel.findById(id).exec();
  }

  async save(notification: Notification): Promise<Notification> {
    return notification.save();
  }
}
