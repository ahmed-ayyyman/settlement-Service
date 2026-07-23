import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SettlementRequest,
  SettlementStatus,
} from './schemas/settlement-request.schema';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { SetFeeDto } from './dto/set-fee.dto';
import { RejectRequestDto } from './dto/reject-request.dto';
import { ListSettlementRequestsQueryDto } from './dto/list-settlement-requests.query.dto';
import { FILE_STORAGE_SERVICE } from '../files/file-storage.service';
import type { FileStorageService } from '../files/file-storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';

@Injectable()
export class SettlementRequestsService {
  constructor(
    @InjectModel(SettlementRequest.name)
    private readonly requestModel: Model<SettlementRequest>,
    @Inject(FILE_STORAGE_SERVICE)
    private readonly fileStorage: FileStorageService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    ownerId: string,
    dto: CreateSettlementRequestDto,
    attachments: Express.Multer.File[],
  ) {
    const existing = await this.requestModel.findOne({
      ownerId,
      status: {
        $in: [
          SettlementStatus.PENDING_REVIEW,
          SettlementStatus.AWAITING_PAYMENT,
          SettlementStatus.AWAITING_SETTLEMENT,
        ],
      },
    });
    if (existing) {
      throw new ConflictException('Request already in progress');
    }

    const meetings = await Promise.all(
      dto.meetings.map(async (m, i) => {
        const meetingDate = new Date(m.meetingDate);
        if (meetingDate > new Date()) {
          throw new BadRequestException(
            `Meeting ${i + 1} date must not be in the future`,
          );
        }
        const stored = await this.fileStorage.store(
          attachments[i],
          'attachments',
        );
        return {
          meetingDate,
          capitalAtMeeting: m.capitalAtMeeting,
          attachmentUrl: stored.key,
          attachmentOriginalName: stored.originalName,
          attachmentMimeType: attachments[i].mimetype,
          fee: null,
          settlementDocumentUrl: null,
          settlementDocumentUploadedAt: null,
        };
      }),
    );

    meetings.sort((a, b) => a.meetingDate.getTime() - b.meetingDate.getTime());

    const request = await this.requestModel.create({
      crn: dto.crn,
      ownerId,
      status: SettlementStatus.PENDING_REVIEW,
      meetings,
    });

    void this.notifications.emit(
      NotificationType.REQUEST_SUBMITTED,
      request._id,
      request.crn,
    );

    return request.toJSON();
  }

  async findMine(ownerId: string) {
    const request = await this.requestModel
      .findOne({ ownerId })
      .sort({ createdAt: -1 })
      .exec();
    return { request: request ?? null };
  }

  async findAll(query: ListSettlementRequestsQueryDto) {
    const filter: any = {};
    if (query.status) {
      filter.status = query.status;
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.requestModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.requestModel.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }

  async findById(id: string, userId?: string, userRoles?: string[]) {
    const request = await this.requestModel.findById(id).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (!userRoles?.includes('backoffice_employee')) {
      if (request.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }
    }
    return request;
  }

  async setFee(requestId: string, meetingId: string, dto: SetFeeDto) {
    const request = await this.requestModel.findById(requestId).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.PENDING_REVIEW) {
      throw new ConflictException('Request is not under review');
    }

    const meeting = (request.meetings as any[]).find(
      (m) => m._id.toString() === meetingId,
    );
    if (!meeting) {
      throw new NotFoundException('Meeting not found in this request');
    }

    await this.requestModel.updateOne(
      { _id: requestId, 'meetings._id': meetingId },
      { $set: { 'meetings.$.fee': dto.fee } },
    );

    return { meetingId, fee: dto.fee };
  }

  async approve(requestId: string, reviewedBy: string) {
    const request = await this.requestModel.findById(requestId).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.PENDING_REVIEW) {
      throw new ConflictException('Request is not under review');
    }

    const missingFee = request.meetings.some(
      (m) => m.fee === null || m.fee === undefined,
    );
    if (missingFee) {
      throw new BadRequestException(
        'All meetings must have a fee set before approval',
      );
    }

    request.status = SettlementStatus.AWAITING_PAYMENT;
    request.reviewedBy = reviewedBy;
    request.reviewedAt = new Date();
    await request.save();

    void this.notifications.emit(
      NotificationType.REQUEST_APPROVED,
      request._id,
      request.crn,
      request.ownerId,
    );

    return { status: request.status };
  }

  async reject(requestId: string, reviewedBy: string, dto?: RejectRequestDto) {
    const request = await this.requestModel.findById(requestId).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.PENDING_REVIEW) {
      throw new ConflictException('Request is not under review');
    }

    request.status = SettlementStatus.REJECTED;
    request.reviewedBy = reviewedBy;
    request.reviewedAt = new Date();
    request.rejectionReason = dto?.rejectionReason ?? null;
    await request.save();

    void this.notifications.emit(
      NotificationType.REQUEST_REJECTED,
      request._id,
      request.crn,
      request.ownerId,
      dto?.rejectionReason,
    );

    return { status: request.status };
  }

  async getPaymentSummary(requestId: string, userId: string) {
    const request = await this.requestModel.findById(requestId).lean();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (
      request.status === SettlementStatus.PENDING_REVIEW ||
      request.status === SettlementStatus.REJECTED
    ) {
      throw new ConflictException(
        'Payment summary not available in current status',
      );
    }

    const meetingFees = request.meetings.map((m) => ({
      meetingId: (m as any)._id,
      fee: m.fee ?? 0,
    }));
    const total = meetingFees.reduce((sum, m) => sum + m.fee, 0);

    return { meetingFees, total };
  }

  async pay(requestId: string, userId: string) {
    const request = await this.requestModel.findById(requestId).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (request.status !== SettlementStatus.AWAITING_PAYMENT) {
      throw new ConflictException('Payment not allowed in current status');
    }

    request.status = SettlementStatus.AWAITING_SETTLEMENT;
    request.paidAt = new Date();
    await request.save();

    void this.notifications.emit(
      NotificationType.PAYMENT_RECEIVED,
      request._id,
      request.crn,
    );

    return { status: request.status };
  }

  async uploadSettlementDocument(
    requestId: string,
    meetingId: string,
    file: Express.Multer.File,
  ) {
    const request = await this.requestModel.findById(requestId).exec();
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.AWAITING_SETTLEMENT) {
      throw new ConflictException('Request is not awaiting settlement');
    }

    const meeting = (request.meetings as any[]).find(
      (m) => m._id.toString() === meetingId,
    );
    if (!meeting) {
      throw new NotFoundException('Meeting not found in this request');
    }

    const stored = await this.fileStorage.store(file, 'settlement-documents');

    await this.requestModel.updateOne(
      { _id: requestId, 'meetings._id': meetingId },
      {
        $set: {
          'meetings.$.settlementDocumentUrl': stored.key,
          'meetings.$.settlementDocumentUploadedAt': new Date(),
        },
      },
    );

    const updated = await this.requestModel.findById(requestId).exec();
    if (!updated) {
      throw new NotFoundException('Settlement request not found after update');
    }
    const allHaveDocs = updated.meetings.every(
      (m) => m.settlementDocumentUrl !== null,
    );

    if (allHaveDocs) {
      updated.status = SettlementStatus.SETTLED;
      updated.settledAt = new Date();
      await updated.save();

      void this.notifications.emit(
        NotificationType.REQUEST_SETTLED,
        updated._id,
        updated.crn,
        updated.ownerId,
      );

      return { status: SettlementStatus.SETTLED, meetingId };
    }

    return { status: SettlementStatus.AWAITING_SETTLEMENT, meetingId };
  }
}
