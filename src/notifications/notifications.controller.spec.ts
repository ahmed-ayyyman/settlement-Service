import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Notification,
  NotificationSchema,
  NotificationType,
} from './schemas/notification.schema';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController - HTTP (leak + auth)', () => {
  let app: INestApplication<App>;
  let mongod: MongoMemoryServer;
  let notificationModel: mongoose.Model<Notification>;
  let currentUser: { sub: string; roles: string[] };
  let service: NotificationsService;

  const fakeAuthGuard = {
    canActivate: (ctx: ExecutionContext) => {
      ctx.switchToHttp().getRequest().user = currentUser;
      return true;
    },
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Notification.name, schema: NotificationSchema },
        ]),
      ],
      controllers: [NotificationsController],
      providers: [
        NotificationsService,
        { provide: APP_GUARD, useValue: fakeAuthGuard },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);
    notificationModel = moduleRef.get(getModelToken(Notification.name));
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await notificationModel.deleteMany({});
  });

  it('does not leak _id / __v in the owner notification list', async () => {
    const reqId = new mongoose.Types.ObjectId();
    await service.emit(
      NotificationType.REQUEST_APPROVED,
      reqId,
      'CRN001',
      'owner-1',
    );

    currentUser = { sub: 'owner-1', roles: ['owner'] };
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .expect(200);

    expect(res.body.notifications).toHaveLength(1);
    const notif = res.body.notifications[0];
    expect(notif.id).toBeDefined();
    expect(notif._id).toBeUndefined();
    expect(notif.__v).toBeUndefined();
    expect(res.body.unreadCount).toBe(1);
  });

  it('returns 403 when an owner tries to mark another owners notification read', async () => {
    const reqId = new mongoose.Types.ObjectId();
    await service.emit(
      NotificationType.REQUEST_APPROVED,
      reqId,
      'CRN001',
      'owner-1',
    );
    const [created] = await notificationModel.find().lean();
    const id = created._id.toString();

    currentUser = { sub: 'owner-2', roles: ['owner'] };
    await request(app.getHttpServer())
      .patch(`/api/notifications/${id}/read`)
      .expect(403);
  });

  it('returns 404 for an invalid notification id (no 500)', async () => {
    currentUser = { sub: 'owner-1', roles: ['owner'] };
    await request(app.getHttpServer())
      .patch('/api/notifications/not-an-objectid/read')
      .expect(404);
  });

  it('forbids an owner from marking a backoffice broadcast read -> 403', async () => {
    const reqId = new mongoose.Types.ObjectId();
    await service.emit(NotificationType.REQUEST_SUBMITTED, reqId, 'CRN001');
    const [created] = await notificationModel.find().lean();
    const id = created._id.toString();

    currentUser = { sub: 'owner-1', roles: ['owner'] };
    await request(app.getHttpServer())
      .patch(`/api/notifications/${id}/read`)
      .expect(403);
  });
});
