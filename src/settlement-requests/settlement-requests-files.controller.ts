import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'stream/promises';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/current-user.decorator';
import { SettlementRequestsService } from './settlement-requests.service';
import { FILE_STORAGE_SERVICE } from '../files/file-storage.service';
import type { FileStorageService } from '../files/file-storage.service';

@Controller('settlement-requests/:id/meetings/:meetingId')
export class SettlementRequestsFilesController {
  constructor(
    private readonly settlementRequestsService: SettlementRequestsService,
    @Inject(FILE_STORAGE_SERVICE)
    private readonly fileStorage: FileStorageService,
  ) {}

  @Get('attachment')
  async getAttachment(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const request = await this.settlementRequestsService.findById(
      id,
      user.sub,
      user.roles,
    );
    const meeting = request.meetings.find((m) => m._id === meetingId);
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    if (!meeting.attachmentUrl) {
      throw new NotFoundException('No attachment for this meeting');
    }
    const file = await this.readOrFail(meeting.attachmentUrl);
    res.set({
      'Content-Type': meeting.attachmentMimeType || file.mimeType,
      'Content-Disposition': `attachment; filename="${meeting.attachmentOriginalName || file.originalName}"`,
      'Content-Length': file.size,
    });
    await pipeline(file.stream, res);
  }

  @Get('settlement-document')
  async getSettlementDocument(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const request = await this.settlementRequestsService.findById(
      id,
      user.sub,
      user.roles,
    );
    const meeting = request.meetings.find((m) => m._id === meetingId);
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    if (!meeting.settlementDocumentUrl) {
      throw new NotFoundException('No settlement document for this meeting');
    }
    const file = await this.readOrFail(meeting.settlementDocumentUrl);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.originalName}"`,
      'Content-Length': file.size,
    });
    await pipeline(file.stream, res);
  }

  private async readOrFail(storageKey: string) {
    try {
      return await this.fileStorage.read(storageKey);
    } catch {
      throw new NotFoundException('File not found on disk');
    }
  }
}
