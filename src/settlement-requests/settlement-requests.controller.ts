import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/current-user.decorator';
import { SettlementRequestsService } from './settlement-requests.service';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { SetFeeDto } from './dto/set-fee.dto';
import { RejectRequestDto } from './dto/reject-request.dto';
import { ListSettlementRequestsQueryDto } from './dto/list-settlement-requests.query.dto';

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFile(file: Express.Multer.File) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      `File type ${file.mimetype} is not allowed. Allowed: PDF, JPEG, PNG`,
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new BadRequestException('File size exceeds 10 MB limit');
  }
}

@Controller('api/settlement-requests')
@UseGuards(AuthGuard('keycloak'), RolesGuard)
export class SettlementRequestsController {
  constructor(
    private readonly settlementRequestsService: SettlementRequestsService,
  ) {}

  @Post()
  @Roles('owner')
  @UseInterceptors(FilesInterceptor('attachments'))
  async create(
    @Body('payload') payloadRaw: string,
    @UploadedFiles() attachments: Express.Multer.File[],
    @CurrentUser() user: JwtUser,
  ) {
    let dto: CreateSettlementRequestDto;
    try {
      const parsed = JSON.parse(payloadRaw);
      dto = plainToInstance(CreateSettlementRequestDto, parsed);
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

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
  async pay(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.settlementRequestsService.pay(id, user.sub);
  }

  @Post(':id/meetings/:meetingId/settlement-document')
  @Roles('backoffice_employee')
  @UseInterceptors(FileInterceptor('file'))
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
