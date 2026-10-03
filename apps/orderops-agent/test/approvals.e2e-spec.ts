import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import type { App } from 'supertest/types.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('refund approvals (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const decide = vi.fn();
  const listPending = vi.fn();
  const resumeRefund = vi.fn();

  const tokenFor = (sub: string, role?: string) =>
    jwt.signAsync(role ? { sub, role } : { sub });
  const operator = () => tokenFor('op_sam', 'operator');

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    // Imported after setting env: ConfigModule validates it when the module loads.
    const { AppModule } = await import('../src/app.module.js');
    const { ChatService } = await import('../src/chat/chat.service.js');
    const { EMBEDDINGS, POLICY_STORE } =
      await import('../src/faq/policy-store.js');
    const { CHECKPOINTER } = await import('../src/memory/checkpointer.js');
    const { USER_MEMORY } = await import('../src/memory/user-memory.store.js');
    const { REFUND_STORE } = await import('../src/refunds/refund.store.js');
    const { TRACE_STORE } = await import('../src/trace/trace.store.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CHECKPOINTER)
      .useValue(new MemorySaver())
      .overrideProvider(TRACE_STORE)
      .useValue({})
      .overrideProvider(REFUND_STORE)
      .useValue({ decide, listPending })
      .overrideProvider(ChatService)
      .useValue({ resumeRefund })
      .overrideProvider(USER_MEMORY)
      .useValue({})
      .overrideProvider(EMBEDDINGS)
      .useValue({})
      .overrideProvider(POLICY_STORE)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = new JwtService({ secret: SECRET });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    decide.mockReset();
    listPending.mockReset();
    resumeRefund.mockReset().mockResolvedValue(undefined);
  });

  const decided = (
    status: 'approved' | 'rejected',
    threadKey: string | null,
  ) => ({
    ok: true,
    refund: {
      id: 'ref_1',
      orderId: 'ord_1',
      customerId: 'cus_ana',
      amount: '89.90',
      status,
      threadKey,
    },
  });

  it.each([
    ['get', '/refunds/pending'],
    ['post', '/refunds/ref_1/approve'],
    ['post', '/refunds/ref_1/reject'],
  ] as const)('%s %s needs a token', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    ['a customer token', () => tokenFor('cus_ana', 'customer')],
    ['a token without a role', () => tokenFor('cus_ana')],
    ['a forged role value', () => tokenFor('cus_ana', 'Operator')],
  ])('refuses %s with 403', async (_label, make) => {
    const auth = `Bearer ${await make()}`;
    await request(app.getHttpServer())
      .get('/refunds/pending')
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .post('/refunds/ref_1/approve')
      .set('Authorization', auth)
      .expect(403);
    expect(decide).not.toHaveBeenCalled();
    expect(listPending).not.toHaveBeenCalled();
  });

  it('lists pending requests for an operator', async () => {
    const refunds = [
      {
        id: 'ref_1',
        orderId: 'ord_1',
        customerId: 'cus_ana',
        amount: '89.90',
        reason: 'Arrived broken',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    ];
    listPending.mockResolvedValue(refunds);
    const res = await request(app.getHttpServer())
      .get('/refunds/pending')
      .set('Authorization', `Bearer ${await operator()}`)
      .expect(200);
    expect(res.body).toEqual({ refunds });
  });

  it('approves a request, takes the operator id from the token, and resumes the stored thread', async () => {
    decide.mockResolvedValue(decided('approved', 'cus_ana:thread-1'));
    const res = await request(app.getHttpServer())
      .post('/refunds/ref_1/approve')
      .set('Authorization', `Bearer ${await operator()}`)
      .send({ operatorId: 'someone_else' })
      .expect(200);
    expect(res.body).toEqual({
      id: 'ref_1',
      status: 'approved',
      decidedBy: 'op_sam',
    });
    expect(decide).toHaveBeenCalledWith({
      id: 'ref_1',
      decision: 'approved',
      operatorId: 'op_sam',
    });
    expect(resumeRefund).toHaveBeenCalledWith(
      'cus_ana:thread-1',
      'cus_ana',
      expect.objectContaining({
        id: 'ref_1',
        orderId: 'ord_1',
        amount: '89.90',
      }),
      'approved',
    );
  });

  it('rejects a request', async () => {
    decide.mockResolvedValue(decided('rejected', 'cus_ana:thread-1'));
    const res = await request(app.getHttpServer())
      .post('/refunds/ref_1/reject')
      .set('Authorization', `Bearer ${await operator()}`)
      .expect(200);
    expect(res.body).toMatchObject({ status: 'rejected', decidedBy: 'op_sam' });
    expect(resumeRefund).toHaveBeenCalledWith(
      'cus_ana:thread-1',
      'cus_ana',
      expect.objectContaining({
        id: 'ref_1',
        orderId: 'ord_1',
        amount: '89.90',
      }),
      'rejected',
    );
  });

  it('decides a request without a stored thread and does not resume anything', async () => {
    decide.mockResolvedValue(decided('approved', null));
    await request(app.getHttpServer())
      .post('/refunds/ref_1/approve')
      .set('Authorization', `Bearer ${await operator()}`)
      .expect(200);
    expect(resumeRefund).not.toHaveBeenCalled();
  });

  it('keeps the committed decision when resuming the thread fails', async () => {
    decide.mockResolvedValue(decided('approved', 'cus_ana:thread-1'));
    resumeRefund.mockRejectedValue(new Error('thread is not paused'));
    await request(app.getHttpServer())
      .post('/refunds/ref_1/approve')
      .set('Authorization', `Bearer ${await operator()}`)
      .expect(200);
  });

  it.each([
    ['not_found', 404],
    ['not_pending', 409],
    ['own_request', 403],
  ] as const)(
    'maps %s to %i without resuming anything',
    async (code, status) => {
      decide.mockResolvedValue({ ok: false, code });
      await request(app.getHttpServer())
        .post('/refunds/ref_1/approve')
        .set('Authorization', `Bearer ${await operator()}`)
        .expect(status);
      expect(resumeRefund).not.toHaveBeenCalled();
    },
  );
});
