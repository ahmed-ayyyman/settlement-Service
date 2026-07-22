import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SettlementRequestsService } from './settlement-requests.service';
import {
  SettlementRequest,
  SettlementRequestSchema,
  SettlementStatus,
} from './schemas/settlement-request.schema';
import { FileStorageService } from '../files/file-storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';

describe('SettlementRequestsService', () => {
  let service: SettlementRequestsService;
  let mongod: MongoMemoryServer;
  let requestModel: Model<SettlementRequest>;

  const mockFileStorage = {
    store: jest.fn(),
    read: jest.fn(),
  };

  const mockNotifications = {
    emit: jest.fn(),
  };

  let mockFileStorageIndex = 0;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    requestModel = mongoose.model(
      SettlementRequest.name,
      SettlementRequestSchema,
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFileStorageIndex = 0;
    await requestModel.deleteMany({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementRequestsService,
        {
          provide: getModelToken(SettlementRequest.name),
          useValue: requestModel,
        },
        { provide: FileStorageService, useValue: mockFileStorage },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get(SettlementRequestsService);
  });

  const createRequest = async (
    ownerId = 'owner-1',
    crn = 'CRN001',
    meetingsCount = 2,
  ) => {
    const dto: CreateSettlementRequestDto = {
      crn,
      meetings: Array.from({ length: meetingsCount }, (_, i) => ({
        meetingDate: `2024-0${i + 1}-15T00:00:00Z`,
        capitalAtMeeting: 100000 * (i + 1),
      })),
    };
    const attachments = Array.from({ length: meetingsCount }, () => ({
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
      size: 1000,
      buffer: Buffer.from('test'),
    })) as Express.Multer.File[];

    mockFileStorage.store.mockImplementation(() => {
      const idx = mockFileStorageIndex++;
      return Promise.resolve({
        key: `attachments/${ownerId}-${idx}`,
        originalName: 'doc.pdf',
      });
    });

    return service.create(ownerId, dto, attachments);
  };

  // --- CREATE ---

  describe('create', () => {
    it('creates a request with PENDING_REVIEW status', async () => {
      const result = await createRequest('owner-1', 'CRN001', 1);
      expect(result.status).toBe(SettlementStatus.PENDING_REVIEW);
      expect(result.crn).toBe('CRN001');
      expect(result.meetings).toHaveLength(1);
    });

    it('rejects a second active request for the same owner', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      await expect(createRequest('owner-1', 'CRN002', 1)).rejects.toThrow(
        'Request already in progress',
      );
    });

    it('allows a second request once the first is terminal', async () => {
      const req1 = await createRequest('owner-1', 'CRN001', 1);
      await requestModel.findByIdAndUpdate(req1.id, {
        status: SettlementStatus.SETTLED,
        settledAt: new Date(),
      });
      await expect(
        createRequest('owner-1', 'CRN002', 1),
      ).resolves.toBeDefined();
    });

    it('allows a different owner to create a request for the same CRN', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      await expect(
        createRequest('owner-2', 'CRN001', 1),
      ).resolves.toBeDefined();
    });

    it('sorts meetings by meetingDate ascending', async () => {
      const dto: CreateSettlementRequestDto = {
        crn: 'CRN001',
        meetings: [
          { meetingDate: '2024-03-15T00:00:00Z', capitalAtMeeting: 300000 },
          { meetingDate: '2024-01-15T00:00:00Z', capitalAtMeeting: 100000 },
          { meetingDate: '2024-02-15T00:00:00Z', capitalAtMeeting: 200000 },
        ],
      };
      const attachments = Array.from({ length: 3 }, () => ({
        originalname: 'doc.pdf',
        mimetype: 'application/pdf',
        size: 1000,
        buffer: Buffer.from('test'),
      })) as Express.Multer.File[];
      mockFileStorage.store.mockResolvedValue({
        key: 'attachments/test',
        originalName: 'doc.pdf',
      });
      const result = await service.create('owner-1', dto, attachments);
      const dates = result.meetings.map(
        (m) => m.meetingDate.toISOString().split('T')[0],
      );
      expect(dates).toEqual(['2024-01-15', '2024-02-15', '2024-03-15']);
    });
  });

  // --- FIND MINE ---

  describe('findMine', () => {
    it('returns null when owner has no requests', async () => {
      const result = await service.findMine('nonexistent');
      expect(result.request).toBeNull();
    });

    it('returns the most recent request', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      const result = await service.findMine('owner-1');
      expect(result.request).not.toBeNull();
      expect(result.request!.crn).toBe('CRN001');
    });
  });

  // --- FIND ALL ---

  describe('findAll (backoffice queue)', () => {
    it('returns paginated requests', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      await createRequest('owner-2', 'CRN002', 1);
      const result = await service.findAll({ page: 1, limit: 10 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('filters by status', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      await createRequest('owner-2', 'CRN002', 1);
      await requestModel.findOneAndUpdate(
        { ownerId: 'owner-1' },
        { status: SettlementStatus.REJECTED },
      );
      const result = await service.findAll({
        status: SettlementStatus.PENDING_REVIEW,
        page: 1,
        limit: 10,
      });
      expect(result.items).toHaveLength(1);
    });
  });

  // --- FEE + APPROVE/REJECT ---

  describe('setFee', () => {
    it('sets fee on a meeting', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      const meetingId = req.meetings[0]._id.toString();
      const result = await service.setFee(
        req.id,
        meetingId,
        { fee: 500 },
        'backoffice-1',
      );
      expect(result.fee).toBe(500);
    });

    it('rejects fee update when request is not PENDING_REVIEW', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await requestModel.findByIdAndUpdate(req.id, {
        status: SettlementStatus.AWAITING_PAYMENT,
      });
      const meetingId = req.meetings[0]._id.toString();
      await expect(
        service.setFee(req.id, meetingId, { fee: 500 }, 'backoffice-1'),
      ).rejects.toThrow('Request is not under review');
    });
  });

  describe('approve', () => {
    it('approves when all meetings have fees', async () => {
      const req = await createRequest('owner-1', 'CRN001', 2);
      for (const meeting of req.meetings) {
        await service.setFee(
          req.id,
          meeting._id.toString(),
          { fee: 250 },
          'backoffice-1',
        );
      }
      const result = await service.approve(req.id, 'backoffice-1');
      expect(result.status).toBe(SettlementStatus.AWAITING_PAYMENT);
    });

    it('rejects approval when a meeting has no fee', async () => {
      const req = await createRequest('owner-1', 'CRN001', 2);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 250 },
        'backoffice-1',
      );
      await expect(service.approve(req.id, 'backoffice-1')).rejects.toThrow(
        'All meetings must have a fee set',
      );
    });

    it('rejects approval when not PENDING_REVIEW', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 250 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      await expect(service.approve(req.id, 'backoffice-1')).rejects.toThrow(
        'Request is not under review',
      );
    });
  });

  describe('reject', () => {
    it('rejects with a reason', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      const result = await service.reject(req.id, 'backoffice-1', {
        rejectionReason: 'Incomplete documents',
      });
      expect(result.status).toBe(SettlementStatus.REJECTED);
      const saved = await requestModel.findById(req.id);
      expect(saved!.rejectionReason).toBe('Incomplete documents');
    });

    it('rejects without a reason', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      const result = await service.reject(req.id, 'backoffice-1', {});
      expect(result.status).toBe(SettlementStatus.REJECTED);
    });

    it('rejects approval from REJECTED state', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.reject(req.id, 'backoffice-1', {});
      await expect(service.approve(req.id, 'backoffice-1')).rejects.toThrow(
        'Request is not under review',
      );
    });
  });

  // --- PAYMENT SUMMARY + PAY ---

  describe('getPaymentSummary', () => {
    it('returns fee breakdown and total', async () => {
      const req = await createRequest('owner-1', 'CRN001', 2);
      for (const meeting of req.meetings) {
        await service.setFee(
          req.id,
          meeting._id.toString(),
          { fee: 300 },
          'backoffice-1',
        );
      }
      await service.approve(req.id, 'backoffice-1');
      const summary = await service.getPaymentSummary(req.id, 'owner-1');
      expect(summary.meetingFees).toHaveLength(2);
      expect(summary.total).toBe(600);
    });

    it('blocks access when status is PENDING_REVIEW', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await expect(
        service.getPaymentSummary(req.id, 'owner-1'),
      ).rejects.toThrow('Payment summary not available');
    });

    it('blocks access when status is REJECTED', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.reject(req.id, 'backoffice-1', {});
      await expect(
        service.getPaymentSummary(req.id, 'owner-1'),
      ).rejects.toThrow('Payment summary not available');
    });

    it('blocks other owners', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await expect(
        service.getPaymentSummary(req.id, 'owner-2'),
      ).rejects.toThrow('Access denied');
    });
  });

  describe('pay', () => {
    it('moves to AWAITING_SETTLEMENT', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      const result = await service.pay(req.id, 'owner-1');
      expect(result.status).toBe(SettlementStatus.AWAITING_SETTLEMENT);
    });

    it('rejects pay from wrong status', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await expect(service.pay(req.id, 'owner-1')).rejects.toThrow(
        'Payment not allowed',
      );
    });

    it('rejects pay from wrong owner', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      await expect(service.pay(req.id, 'owner-2')).rejects.toThrow(
        'Access denied',
      );
    });
  });

  // --- SETTLEMENT DOCUMENT UPLOAD ---

  describe('uploadSettlementDocument', () => {
    it('uploads a document and stays in AWAITING_SETTLEMENT if not all docs are in', async () => {
      const req = await createRequest('owner-1', 'CRN001', 2);
      for (const meeting of req.meetings) {
        await service.setFee(
          req.id,
          meeting._id.toString(),
          { fee: 100 },
          'backoffice-1',
        );
      }
      await service.approve(req.id, 'backoffice-1');
      await service.pay(req.id, 'owner-1');

      mockFileStorage.store.mockResolvedValue({
        key: 'settlement-documents/test.pdf',
        originalName: 'doc.pdf',
      });
      const result = await service.uploadSettlementDocument(
        req.id,
        req.meetings[0]._id.toString(),
        {
          originalname: 'doc.pdf',
          mimetype: 'application/pdf',
          size: 1000,
          buffer: Buffer.from('test'),
        } as Express.Multer.File,
      );
      expect(result.status).toBe(SettlementStatus.AWAITING_SETTLEMENT);
    });

    it('auto-settles when all meeting docs are uploaded', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      await service.pay(req.id, 'owner-1');

      mockFileStorage.store.mockResolvedValue({
        key: 'settlement-documents/test.pdf',
        originalName: 'doc.pdf',
      });
      const result = await service.uploadSettlementDocument(
        req.id,
        req.meetings[0]._id.toString(),
        {
          originalname: 'doc.pdf',
          mimetype: 'application/pdf',
          size: 1000,
          buffer: Buffer.from('test'),
        } as Express.Multer.File,
      );
      expect(result.status).toBe(SettlementStatus.SETTLED);
    });

    it('rejects upload when not in AWAITING_SETTLEMENT', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await expect(
        service.uploadSettlementDocument(
          req.id,
          req.meetings[0]._id.toString(),
          {
            originalname: 'doc.pdf',
            mimetype: 'application/pdf',
            size: 1000,
            buffer: Buffer.from('test'),
          } as Express.Multer.File,
        ),
      ).rejects.toThrow('Request is not awaiting settlement');
    });
  });

  // --- NOTIFICATIONS ---

  describe('notification emission', () => {
    it('emits REQUEST_SUBMITTED on create', async () => {
      await createRequest('owner-1', 'CRN001', 1);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        'REQUEST_SUBMITTED',
        expect.anything(),
        'CRN001',
      );
    });

    it('emits REQUEST_APPROVED on approve', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        'REQUEST_APPROVED',
        expect.anything(),
        'CRN001',
        'owner-1',
      );
    });

    it('emits REQUEST_REJECTED on reject', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.reject(req.id, 'backoffice-1', {
        rejectionReason: 'Bad docs',
      });
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        'REQUEST_REJECTED',
        expect.anything(),
        'CRN001',
        'owner-1',
        'Bad docs',
      );
    });

    it('emits PAYMENT_RECEIVED on pay', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      await service.pay(req.id, 'owner-1');
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        'PAYMENT_RECEIVED',
        expect.anything(),
        'CRN001',
      );
    });

    it('emits REQUEST_SETTLED on auto-settle', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await service.setFee(
        req.id,
        req.meetings[0]._id.toString(),
        { fee: 100 },
        'backoffice-1',
      );
      await service.approve(req.id, 'backoffice-1');
      await service.pay(req.id, 'owner-1');
      mockFileStorage.store.mockResolvedValue({
        key: 'settlement-documents/test.pdf',
        originalName: 'doc.pdf',
      });
      await service.uploadSettlementDocument(
        req.id,
        req.meetings[0]._id.toString(),
        {
          originalname: 'doc.pdf',
          mimetype: 'application/pdf',
          size: 1000,
          buffer: Buffer.from('test'),
        } as Express.Multer.File,
      );
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        'REQUEST_SETTLED',
        expect.anything(),
        'CRN001',
        'owner-1',
      );
    });
  });

  // --- FIND BY ID ---

  describe('findById', () => {
    it('returns a request for the owner', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      const result = await service.findById(req.id, 'owner-1', ['owner']);
      expect(result.crn).toBe('CRN001');
    });

    it('allows backoffice to view any request', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      const result = await service.findById(req.id, 'backoffice-1', [
        'backoffice_employee',
      ]);
      expect(result.crn).toBe('CRN001');
    });

    it('forbids other owners', async () => {
      const req = await createRequest('owner-1', 'CRN001', 1);
      await expect(
        service.findById(req.id, 'owner-2', ['owner']),
      ).rejects.toThrow('Access denied');
    });
  });
});
