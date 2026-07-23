import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SettlementRequest,
  SettlementRequestSchema,
} from './schemas/settlement-request.schema';
import { SettlementRequestsController } from './settlement-requests.controller';
import { SettlementRequestsFilesController } from './settlement-requests-files.controller';
import { SettlementRequestsService } from './settlement-requests.service';
import { SettlementRequestRepository } from './repositories/settlement-request.repository';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SettlementRequest.name, schema: SettlementRequestSchema },
    ]),
    FilesModule,
    NotificationsModule,
  ],
  controllers: [
    SettlementRequestsController,
    SettlementRequestsFilesController,
  ],
  providers: [SettlementRequestsService, SettlementRequestRepository],
})
export class SettlementRequestsModule {}
