import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NotificationsService } from './notifications.service';
import { NotificationRepository } from './repositories/notification.repository';
import {
  Notification,
  NotificationSchema,
  NotificationType,
} from './schemas/notification.schema';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mongod: MongoMemoryServer;
  let notificationModel: Model<Notification>;
  let module: TestingModule;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    notificationModel = mongoose.model(Notification.name, NotificationSchema);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await notificationModel.deleteMany({});
    module = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationRepository,
        {
          provide: getModelToken(Notification.name),
          useValue: notificationModel,
        },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  const createRequestId = () => new mongoose.Types.ObjectId();

  describe('emit', () => {
    it('creates a broadcast notification for backoffice', async () => {
      const reqId = createRequestId();
      await service.emit(NotificationType.REQUEST_SUBMITTED, reqId, 'CRN001');
      const notifications = await notificationModel.find().lean();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].recipientId).toBeNull();
      expect(notifications[0].recipientRole).toBe('backoffice_employee');
      expect(notifications[0].message).toContain('CRN001');
    });

    it('creates an individual notification for owner', async () => {
      const reqId = createRequestId();
      await service.emit(
        NotificationType.REQUEST_APPROVED,
        reqId,
        'CRN001',
        'owner-1',
      );
      const notifications = await notificationModel.find().lean();
      expect(notifications[0].recipientId).toBe('owner-1');
      expect(notifications[0].recipientRole).toBe('owner');
    });

    it('includes rejection reason in the message', async () => {
      const reqId = createRequestId();
      await service.emit(
        NotificationType.REQUEST_REJECTED,
        reqId,
        'CRN001',
        'owner-1',
        'Bad documents',
      );
      const notifications = await notificationModel.find().lean();
      expect(notifications[0].message).toContain('Bad documents');
    });

    it('never throws upstream on failure', async () => {
      await expect(
        service.emit(
          NotificationType.REQUEST_SUBMITTED,
          'bad-id' as any,
          'CRN001',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('findForOwner', () => {
    it('returns only notifications for the given owner', async () => {
      const reqId = createRequestId();
      await service.emit(
        NotificationType.REQUEST_APPROVED,
        reqId,
        'CRN001',
        'owner-1',
      );
      await service.emit(
        NotificationType.REQUEST_APPROVED,
        reqId,
        'CRN002',
        'owner-2',
      );
      const owner1Notifications = await service.findForOwner('owner-1');
      expect(owner1Notifications).toHaveLength(1);
    });
  });

  describe('findForBackoffice', () => {
    it('returns all backoffice broadcast notifications', async () => {
      const reqId = createRequestId();
      await service.emit(NotificationType.REQUEST_SUBMITTED, reqId, 'CRN001');
      await service.emit(NotificationType.PAYMENT_RECEIVED, reqId, 'CRN002');
      const notifications = await service.findForBackoffice();
      expect(notifications).toHaveLength(2);
    });
  });

  describe('markAsRead', () => {
    it('marks an owner notification as read', async () => {
      const reqId = createRequestId();
      await service.emit(
        NotificationType.REQUEST_APPROVED,
        reqId,
        'CRN001',
        'owner-1',
      );
      const notifications = await notificationModel.find().lean();
      const notifId = notifications[0]._id.toString();
      const result = await service.markAsRead(notifId, 'owner-1', ['owner']);
      expect(result).not.toBeNull();
      expect((result as any).isRead).toBe(true);
    });

    it('returns FORBIDDEN for another owners notification', async () => {
      const reqId = createRequestId();
      await service.emit(
        NotificationType.REQUEST_APPROVED,
        reqId,
        'CRN001',
        'owner-1',
      );
      const notifications = await notificationModel.find().lean();
      const notifId = notifications[0]._id.toString();
      const result = await service.markAsRead(notifId, 'owner-2', ['owner']);
      expect(result).toBe('FORBIDDEN');
    });

    it('returns FORBIDDEN when an owner tries to mark a backoffice broadcast', async () => {
      const reqId = createRequestId();
      await service.emit(NotificationType.REQUEST_SUBMITTED, reqId, 'CRN001');
      const notifications = await notificationModel.find().lean();
      const notifId = notifications[0]._id.toString();
      const result = await service.markAsRead(notifId, 'owner-1', ['owner']);
      expect(result).toBe('FORBIDDEN');
    });

    it('allows backoffice to mark a broadcast notification', async () => {
      const reqId = createRequestId();
      await service.emit(NotificationType.REQUEST_SUBMITTED, reqId, 'CRN001');
      const notifications = await notificationModel.find().lean();
      const notifId = notifications[0]._id.toString();
      const result = await service.markAsRead(notifId, 'backoffice-1', [
        'backoffice_employee',
      ]);
      expect((result as any).isRead).toBe(true);
    });

    it('returns null for an invalid notification id (no 500)', async () => {
      const result = await service.markAsRead('not-a-valid-id', 'owner-1', [
        'owner',
      ]);
      expect(result).toBeNull();
    });

    it('returns null for a non-existent notification', async () => {
      const result = await service.markAsRead(
        new mongoose.Types.ObjectId().toString(),
        'owner-1',
        ['owner'],
      );
      expect(result).toBeNull();
    });
  });
});
