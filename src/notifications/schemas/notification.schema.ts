import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum NotificationType {
  REQUEST_SUBMITTED = 'REQUEST_SUBMITTED',
  REQUEST_APPROVED = 'REQUEST_APPROVED',
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  REQUEST_SETTLED = 'REQUEST_SETTLED',
}

@Schema({ timestamps: true, collection: 'notifications' })
export class Notification extends Document {
  @Prop({ type: String, default: null })
  recipientId: string | null;

  @Prop({
    required: true,
    type: String,
    enum: ['owner', 'backoffice_employee'],
  })
  recipientRole: string;

  @Prop({ required: true, type: String, enum: NotificationType })
  type: NotificationType;

  @Prop({ required: true })
  message: string;

  @Prop({ required: true, type: Types.ObjectId, ref: 'SettlementRequest' })
  relatedRequestId: Types.ObjectId;

  @Prop({ default: false })
  isRead: boolean;

  createdAt: Date;
  updatedAt: Date;
}
export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

NotificationSchema.index({ recipientId: 1, createdAt: -1 });
NotificationSchema.index({ recipientRole: 1, createdAt: -1 });
