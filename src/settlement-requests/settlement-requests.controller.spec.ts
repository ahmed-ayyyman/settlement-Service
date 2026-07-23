import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { RolesGuard } from '../auth/roles.guard';
import { SettlementRequestsController } from './settlement-requests.controller';
import { SettlementRequestsService } from './settlement-requests.service';

describe('SettlementRequestsController - role enforcement (HTTP)', () => {
  let app: INestApplication<App>;
  let currentUser: { sub: string; roles: string[] };

  const mockService = {
    create: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'PENDING_REVIEW' }),
    findMine: jest.fn().mockResolvedValue({ request: null }),
    findAll: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    findById: jest.fn().mockResolvedValue({ id: 'req-1' }),
    setFee: jest.fn().mockResolvedValue({ meetingId: 'm-1', fee: 500 }),
    approve: jest.fn().mockResolvedValue({ status: 'AWAITING_PAYMENT' }),
    reject: jest.fn().mockResolvedValue({ status: 'REJECTED' }),
    getPaymentSummary: jest
      .fn()
      .mockResolvedValue({ meetingFees: [], total: 0 }),
    pay: jest.fn().mockResolvedValue({ status: 'AWAITING_SETTLEMENT' }),
    uploadSettlementDocument: jest.fn().mockResolvedValue({
      status: 'AWAITING_SETTLEMENT',
      meetingId: 'm-1',
    }),
  };

  const fakeAuthGuard = {
    canActivate: (ctx: ExecutionContext) => {
      ctx.switchToHttp().getRequest().user = currentUser;
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SettlementRequestsController],
      providers: [
        { provide: SettlementRequestsService, useValue: mockService },
        { provide: APP_GUARD, useValue: fakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const owner = { sub: 'owner-1', roles: ['owner'] };
  const backoffice = { sub: 'backoffice-1', roles: ['backoffice_employee'] };

  it('allows an owner to create a request (reaches the service)', async () => {
    currentUser = owner;
    await request(app.getHttpServer())
      .post('/api/settlement-requests')
      .field(
        'payload',
        JSON.stringify({
          crn: 'CRN001',
          meetings: [{ meetingDate: '2024-01-01', capitalAtMeeting: 1000 }],
        }),
      )
      .attach('attachments', Buffer.from('pdf'), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(mockService.create).toHaveBeenCalled();
  });

  it('forbids backoffice from creating a request (owner-only) -> 403', async () => {
    currentUser = backoffice;
    const res = await request(app.getHttpServer())
      .post('/api/settlement-requests')
      .field('payload', JSON.stringify({ crn: 'CRN001', meetings: [] }))
      .expect(403);
    expect(mockService.create).not.toHaveBeenCalled();
    expect(res.body.message).toMatch(/owner/);
  });

  it('forbids owner from setting a fee (backoffice-only) -> 403', async () => {
    currentUser = owner;
    await request(app.getHttpServer())
      .patch('/api/settlement-requests/req-1/meetings/m-1/fee')
      .send({ fee: 500 })
      .expect(403);
    expect(mockService.setFee).not.toHaveBeenCalled();
  });

  it('forbids owner from approving (backoffice-only) -> 403', async () => {
    currentUser = owner;
    await request(app.getHttpServer())
      .post('/api/settlement-requests/req-1/approve')
      .expect(403);
    expect(mockService.approve).not.toHaveBeenCalled();
  });

  it('forbids owner from rejecting (backoffice-only) -> 403', async () => {
    currentUser = owner;
    await request(app.getHttpServer())
      .post('/api/settlement-requests/req-1/reject')
      .send({ rejectionReason: 'bad' })
      .expect(403);
    expect(mockService.reject).not.toHaveBeenCalled();
  });

  it('forbids backoffice from paying (owner-only) -> 403', async () => {
    currentUser = backoffice;
    await request(app.getHttpServer())
      .post('/api/settlement-requests/req-1/pay')
      .expect(403);
    expect(mockService.pay).not.toHaveBeenCalled();
  });

  it('forbids backoffice from viewing payment-summary (owner-only) -> 403', async () => {
    currentUser = backoffice;
    await request(app.getHttpServer())
      .get('/api/settlement-requests/req-1/payment-summary')
      .expect(403);
    expect(mockService.getPaymentSummary).not.toHaveBeenCalled();
  });

  it('forbids owner from uploading a settlement document (backoffice-only) -> 403', async () => {
    currentUser = owner;
    await request(app.getHttpServer())
      .post('/api/settlement-requests/req-1/meetings/m-1/settlement-document')
      .attach('file', Buffer.from('x'), {
        filename: 'd.pdf',
        contentType: 'application/pdf',
      })
      .expect(403);
    expect(mockService.uploadSettlementDocument).not.toHaveBeenCalled();
  });

  it('allows backoffice to approve (reaches the service)', async () => {
    currentUser = backoffice;
    await request(app.getHttpServer())
      .post('/api/settlement-requests/req-1/approve')
      .expect(200);
    expect(mockService.approve).toHaveBeenCalled();
  });
});
