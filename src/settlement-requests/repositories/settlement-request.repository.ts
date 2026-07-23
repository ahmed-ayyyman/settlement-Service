import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Meeting,
  SettlementRequest,
  SettlementStatus,
} from '../schemas/settlement-request.schema';

export interface MeetingDocument extends Meeting {
  _id: Types.ObjectId;
}

export interface PaginationInput {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export type SettlementRequestDocument =
  SettlementRequest | (SettlementRequest & { _id: Types.ObjectId });

@Injectable()
export class SettlementRequestRepository {
  constructor(
    @InjectModel(SettlementRequest.name)
    private readonly requestModel: Model<SettlementRequest>,
  ) {}

  async findActiveByOwner(ownerId: string): Promise<SettlementRequest | null> {
    return this.requestModel
      .findOne({
        ownerId,
        status: {
          $in: [
            SettlementStatus.PENDING_REVIEW,
            SettlementStatus.AWAITING_PAYMENT,
            SettlementStatus.AWAITING_SETTLEMENT,
          ],
        },
      })
      .exec();
  }

  async create(data: Partial<SettlementRequest>): Promise<SettlementRequest> {
    return this.requestModel.create(data);
  }

  async findMostRecentByOwner(
    ownerId: string,
  ): Promise<SettlementRequest | null> {
    return this.requestModel
      .findOne({ ownerId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findAllPaginated(
    filter: Record<string, unknown>,
    pagination: PaginationInput,
  ): Promise<PaginatedResult<SettlementRequest>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
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

  async findById(id: string): Promise<SettlementRequest | null> {
    return this.requestModel.findById(id).exec();
  }

  async findByIdLean(id: string): Promise<SettlementRequest | null> {
    return this.requestModel.findById(id).lean().exec();
  }

  async updateMeetingFee(
    requestId: string,
    meetingId: string,
    fee: number,
  ): Promise<void> {
    await this.requestModel
      .updateOne(
        { _id: requestId, 'meetings._id': meetingId },
        { $set: { 'meetings.$.fee': fee } },
      )
      .exec();
  }

  async updateMeetingSettlementDocument(
    requestId: string,
    meetingId: string,
    url: string,
  ): Promise<void> {
    await this.requestModel
      .updateOne(
        { _id: requestId, 'meetings._id': meetingId },
        {
          $set: {
            'meetings.$.settlementDocumentUrl': url,
            'meetings.$.settlementDocumentUploadedAt': new Date(),
          },
        },
      )
      .exec();
  }

  async save(request: SettlementRequest): Promise<SettlementRequest> {
    return request.save();
  }

  findMeetingById(
    request: SettlementRequest,
    meetingId: string,
  ): MeetingDocument | undefined {
    return (request.meetings as MeetingDocument[]).find(
      (m) => m._id.toString() === meetingId,
    );
  }

  getMeetingsWithFees(
    request: SettlementRequest,
  ): { meetingId: string; fee: number }[] {
    return (request.meetings as MeetingDocument[]).map((m) => ({
      meetingId: m._id.toString(),
      fee: m.fee ?? 0,
    }));
  }

  allMeetingsHaveFees(request: SettlementRequest): boolean {
    return request.meetings.every((m) => m.fee !== null && m.fee !== undefined);
  }

  allMeetingsHaveDocuments(request: SettlementRequest): boolean {
    return request.meetings.every((m) => m.settlementDocumentUrl !== null);
  }
}
