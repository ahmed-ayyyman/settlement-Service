import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/current-user.decorator';
import { SettlementRequestsService } from './settlement-requests.service';
import { ParseJsonPayloadPipe } from '../common/pipes/parse-json-payload.pipe';
import { CreateSettlementRequestDto } from './dto/input/create-settlement-request.dto';
import { SetFeeDto } from './dto/input/set-fee.dto';
import { RejectRequestDto } from './dto/input/reject-request.dto';
import { ListSettlementRequestsQueryDto } from './dto/input/list-settlement-requests.query.dto';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_UPLOAD_SIZE_MB,
} from '../common/constants';

function validateFile(file: Express.Multer.File) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      `File type ${file.mimetype} is not allowed. Allowed: PDF, JPEG, PNG`,
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new BadRequestException(
      `File size exceeds ${MAX_UPLOAD_SIZE_MB} MB limit`,
    );
  }
}

@Controller('settlement-requests')
export class SettlementRequestsController {
  constructor(
    private readonly settlementRequestsService: SettlementRequestsService,
  ) {}

  @Post()
  @Roles('owner')
  @UseInterceptors(
    FilesInterceptor('attachments', undefined, {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async create(
    @Body() body: { payload?: string },
    @UploadedFiles() attachments: Express.Multer.File[],
    @CurrentUser() user: JwtUser,
  ) {
    // Parse the multipart 'payload' field manually. We cannot use
    // @Body('payload', ParseJsonPayloadPipe) + DTO-typed param here because
    // the global ValidationPipe (transform:true) would run first and try to
    // coerce the raw multipart string into the DTO before our pipe runs.
    const dto = await new ParseJsonPayloadPipe(
      CreateSettlementRequestDto,
    ).transform(body?.payload);

    if (!attachments || attachments.length !== dto.meetings.length) {
      throw new BadRequestException(
        'One attachment is required per meeting, in the same order.',
      );
    }

    for (const file of attachments) {
      validateFile(file);
    }

    return this.settlementRequestsService.create(user.sub, dto, attachments);
  }

  @Get('mine')
  @Roles('owner')
  async findMine(@CurrentUser() user: JwtUser) {
    return this.settlementRequestsService.findMine(user.sub);
  }

  @Get()
  @Roles('backoffice_employee')
  async findAll(@Query() query: ListSettlementRequestsQueryDto) {
    return this.settlementRequestsService.findAll(query);
  }

  @Get(':id')
  async findById(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.settlementRequestsService.findById(id, user.sub, user.roles);
  }

  @Patch(':id/meetings/:meetingId/fee')
  @Roles('backoffice_employee')
  async setFee(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Body() dto: SetFeeDto,
  ) {
    return this.settlementRequestsService.setFee(id, meetingId, dto);
  }

  @Post(':id/approve')
  @Roles('backoffice_employee')
  @HttpCode(200)
  async approve(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.settlementRequestsService.approve(id, user.sub);
  }

  @Post(':id/reject')
  @Roles('backoffice_employee')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.settlementRequestsService.reject(id, user.sub, dto);
  }

  @Get(':id/payment-summary')
  @Roles('owner')
  async getPaymentSummary(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.settlementRequestsService.getPaymentSummary(id, user.sub);
  }

  @Post(':id/pay')
  @Roles('owner')
  @HttpCode(200)
  async pay(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.settlementRequestsService.pay(id, user.sub);
  }

  @Post(':id/meetings/:meetingId/settlement-document')
  @Roles('backoffice_employee')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  async uploadSettlementDocument(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    validateFile(file);
    return this.settlementRequestsService.uploadSettlementDocument(
      id,
      meetingId,
      file,
    );
  }
}
