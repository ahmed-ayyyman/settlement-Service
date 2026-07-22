import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum SettlementStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  REJECTED = 'REJECTED',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  AWAITING_SETTLEMENT = 'AWAITING_SETTLEMENT',
  SETTLED = 'SETTLED',
}

@Schema({ _id: true, timestamps: false })
export class Meeting {
  @Prop({ required: true })
  meetingDate: Date;

  @Prop({ required: true, min: 0 })
  capitalAtMeeting: number;

  @Prop({ required: true })
  attachmentUrl: string;

  @Prop()
  attachmentOriginalName?: string;

  @Prop({ type: Number, default: null, min: 0 })
  fee: number | null;

  @Prop({ type: String, default: null })
  settlementDocumentUrl: string | null;

  @Prop({ type: Date, default: null })
  settlementDocumentUploadedAt: Date | null;
}
export const MeetingSchema = SchemaFactory.createForClass(Meeting);

@Schema({ timestamps: true, collection: 'settlement_requests' })
export class SettlementRequest extends Document {
  @Prop({ required: true })
  crn: string;

  @Prop({ required: true })
  ownerId: string;

  @Prop({
    required: true,
    type: String,
    enum: SettlementStatus,
    default: SettlementStatus.PENDING_REVIEW,
  })
  status: SettlementStatus;

  @Prop({
    type: [MeetingSchema],
    required: true,
    validate: [(arr: Meeting[]) => arr.length > 0, 'At least one meeting is required'],
  })
  meetings: Meeting[];

  @Prop({ type: String, default: null })
  reviewedBy: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  rejectionReason: string | null;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  @Prop({ type: Date, default: null })
  settledAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
export const SettlementRequestSchema = SchemaFactory.createForClass(SettlementRequest);

SettlementRequestSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

SettlementRequestSchema.index(
  { ownerId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          SettlementStatus.PENDING_REVIEW,
          SettlementStatus.AWAITING_PAYMENT,
          SettlementStatus.AWAITING_SETTLEMENT,
        ],
      },
    },
  },
);

SettlementRequestSchema.index({ status: 1, createdAt: -1 });
SettlementRequestSchema.index({ crn: 1 });
