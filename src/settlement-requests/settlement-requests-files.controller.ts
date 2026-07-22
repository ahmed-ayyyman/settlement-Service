import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/current-user.decorator';
import { SettlementRequestsService } from './settlement-requests.service';
import { FileStorageService } from '../files/file-storage.service';

@Controller('api/settlement-requests/:id/meetings/:meetingId')
@UseGuards(AuthGuard('keycloak'), RolesGuard)
export class SettlementRequestsFilesController {
  constructor(
    private readonly settlementRequestsService: SettlementRequestsService,
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
    const meeting = (request.meetings as any[]).find(
      (m: any) => m._id.toString() === meetingId || m._id === meetingId,
    );
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    if (!meeting.attachmentUrl) {
      throw new NotFoundException('No attachment for this meeting');
    }
    const file = await this.fileStorage.read(meeting.attachmentUrl);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${meeting.attachmentOriginalName || 'attachment'}"`,
    });
    res.send(file.buffer);
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
    const meeting = (request.meetings as any[]).find(
      (m: any) => m._id.toString() === meetingId || m._id === meetingId,
    );
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    if (!meeting.settlementDocumentUrl) {
      throw new NotFoundException('No settlement document for this meeting');
    }
    const file = await this.fileStorage.read(meeting.settlementDocumentUrl);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="settlement-document"`,
    });
    res.send(file.buffer);
  }
}
