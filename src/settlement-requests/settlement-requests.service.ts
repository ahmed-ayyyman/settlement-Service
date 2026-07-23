import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  SettlementRequest,
  SettlementStatus,
} from './schemas/settlement-request.schema';
import { CreateSettlementRequestDto } from './dto/input/create-settlement-request.dto';
import { SetFeeDto } from './dto/input/set-fee.dto';
import { RejectRequestDto } from './dto/input/reject-request.dto';
import { ListSettlementRequestsQueryDto } from './dto/input/list-settlement-requests.query.dto';
import { SettlementRequestRepository } from './repositories/settlement-request.repository';
import { SettlementRequestResponseDto } from './dto/output/settlement-request-response.dto';
import { FindMineResponseDto } from './dto/output/find-mine-response.dto';
import { PaginatedResponseDto } from './dto/output/paginated-response.dto';
import { SetFeeResponseDto } from './dto/output/set-fee-response.dto';
import { ApproveResponseDto } from './dto/output/approve-response.dto';
import { RejectResponseDto } from './dto/output/reject-response.dto';
import {
  PaymentSummaryMeetingFeeDto,
  PaymentSummaryResponseDto,
} from './dto/output/payment-summary-response.dto';
import { PayResponseDto } from './dto/output/pay-response.dto';
import { UploadSettlementDocumentResponseDto } from './dto/output/upload-document-response.dto';
import { FILE_STORAGE_SERVICE } from '../files/file-storage.service';
import type { FileStorageService } from '../files/file-storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';

@Injectable()
export class SettlementRequestsService {
  constructor(
    private readonly requestRepo: SettlementRequestRepository,
    @Inject(FILE_STORAGE_SERVICE)
    private readonly fileStorage: FileStorageService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    ownerId: string,
    dto: CreateSettlementRequestDto,
    attachments: Express.Multer.File[],
  ): Promise<SettlementRequestResponseDto> {
    const existing = await this.requestRepo.findActiveByOwner(ownerId);
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

    const request = await this.requestRepo.create({
      crn: dto.crn,
      ownerId,
      status: SettlementStatus.PENDING_REVIEW,
      meetings,
    });

    this.notifications
      .emit(NotificationType.REQUEST_SUBMITTED, request._id, request.crn)
      .catch(() => {});

    return this.toResponse(request);
  }

  async findMine(ownerId: string): Promise<FindMineResponseDto> {
    const request = await this.requestRepo.findMostRecentByOwner(ownerId);
    return {
      request: request ? this.toResponse(request) : null,
    };
  }

  async findAll(
    query: ListSettlementRequestsQueryDto,
  ): Promise<PaginatedResponseDto<SettlementRequestResponseDto>> {
    const filter: Record<string, unknown> = {};
    if (query.status) {
      filter.status = query.status;
    }

    const result = await this.requestRepo.findAllPaginated(filter, query);
    return {
      items: result.items.map((item) => this.toResponse(item)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  async findById(
    id: string,
    userId?: string,
    userRoles?: string[],
  ): Promise<SettlementRequestResponseDto> {
    const request = await this.requestRepo.findById(id);
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (!userRoles?.includes('backoffice_employee')) {
      if (request.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }
    }
    return this.toResponse(request);
  }

  async setFee(
    requestId: string,
    meetingId: string,
    dto: SetFeeDto,
  ): Promise<SetFeeResponseDto> {
    const request = await this.requestRepo.findById(requestId);
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.PENDING_REVIEW) {
      throw new ConflictException('Request is not under review');
    }

    const meeting = this.requestRepo.findMeetingById(request, meetingId);
    if (!meeting) {
      throw new NotFoundException('Meeting not found in this request');
    }

    await this.requestRepo.updateMeetingFee(requestId, meetingId, dto.fee);

    return { meetingId, fee: dto.fee };
  }

  async approve(
    requestId: string,
    reviewedBy: string,
  ): Promise<ApproveResponseDto> {
    const request = await this.requestRepo.findById(requestId);
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.PENDING_REVIEW) {
      throw new ConflictException('Request is not under review');
    }

    if (!this.requestRepo.allMeetingsHaveFees(request)) {
      throw new BadRequestException(
        'All meetings must have a fee set before approval',
      );
    }

    request.status = SettlementStatus.AWAITING_PAYMENT;
    request.reviewedBy = reviewedBy;
    request.reviewedAt = new Date();
    await this.requestRepo.save(request);

    this.notifications
      .emit(
        NotificationType.REQUEST_APPROVED,
        request._id,
        request.crn,
        request.ownerId,
      )
      .catch(() => {});

    return { status: SettlementStatus.AWAITING_PAYMENT };
  }

  async reject(
    requestId: string,
    reviewedBy: string,
    dto?: RejectRequestDto,
  ): Promise<RejectResponseDto> {
    const request = await this.requestRepo.findById(requestId);
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
    await this.requestRepo.save(request);

    this.notifications
      .emit(
        NotificationType.REQUEST_REJECTED,
        request._id,
        request.crn,
        request.ownerId,
        dto?.rejectionReason,
      )
      .catch(() => {});

    return { status: SettlementStatus.REJECTED };
  }

  async getPaymentSummary(
    requestId: string,
    userId: string,
  ): Promise<PaymentSummaryResponseDto> {
    const request = await this.requestRepo.findByIdLean(requestId);
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

    const meetingFees: PaymentSummaryMeetingFeeDto[] =
      this.requestRepo.getMeetingsWithFees(request);
    const total = meetingFees.reduce((sum, m) => sum + m.fee, 0);

    return { meetingFees, total };
  }

  async pay(requestId: string, userId: string): Promise<PayResponseDto> {
    const request = await this.requestRepo.findById(requestId);
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
    await this.requestRepo.save(request);

    this.notifications
      .emit(NotificationType.PAYMENT_RECEIVED, request._id, request.crn)
      .catch(() => {});

    return { status: SettlementStatus.AWAITING_SETTLEMENT };
  }

  async uploadSettlementDocument(
    requestId: string,
    meetingId: string,
    file: Express.Multer.File,
  ): Promise<UploadSettlementDocumentResponseDto> {
    const request = await this.requestRepo.findById(requestId);
    if (!request) {
      throw new NotFoundException('Settlement request not found');
    }
    if (request.status !== SettlementStatus.AWAITING_SETTLEMENT) {
      throw new ConflictException('Request is not awaiting settlement');
    }

    const meeting = this.requestRepo.findMeetingById(request, meetingId);
    if (!meeting) {
      throw new NotFoundException('Meeting not found in this request');
    }

    const stored = await this.fileStorage.store(file, 'settlement-documents');
    await this.requestRepo.updateMeetingSettlementDocument(
      requestId,
      meetingId,
      stored.key,
    );

    const updated = await this.requestRepo.findById(requestId);
    if (!updated) {
      throw new NotFoundException('Settlement request not found after update');
    }

    if (this.requestRepo.allMeetingsHaveDocuments(updated)) {
      updated.status = SettlementStatus.SETTLED;
      updated.settledAt = new Date();
      await this.requestRepo.save(updated);

      this.notifications
        .emit(
          NotificationType.REQUEST_SETTLED,
          updated._id,
          updated.crn,
          updated.ownerId,
        )
        .catch(() => {});

      return { status: SettlementStatus.SETTLED, meetingId };
    }

    return { status: SettlementStatus.AWAITING_SETTLEMENT, meetingId };
  }

  private toResponse(request: SettlementRequest): SettlementRequestResponseDto {
    const json = request.toJSON();
    return {
      ...json,
      meetings: json.meetings.map((m: any) => ({
        ...m,
        _id: m._id ? m._id.toString() : m._id,
      })),
    };
  }
}
