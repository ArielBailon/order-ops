import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import { EMBEDDINGS, POLICY_STORE } from '../src/faq/policy-store.js';
import { CHECKPOINTER } from '../src/memory/checkpointer.js';
import { USER_MEMORY } from '../src/memory/user-memory.store.js';
import { REFUND_STORE } from '../src/refunds/refund.store.js';
import { TRACE_STORE } from '../src/trace/trace.store.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';
const ORIGIN = 'https://evil.example';

// The console calls the gateway from its server, so no browser origin needs access: CORS stays off.
describe('gateway CORS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CHECKPOINTER)
      .useValue(new MemorySaver())
      .overrideProvider(TRACE_STORE)
      .useValue({})
      .overrideProvider(REFUND_STORE)
      .useValue({})
      .overrideProvider(USER_MEMORY)
      .useValue({})
      .overrideProvider(EMBEDDINGS)
      .useValue({})
      .overrideProvider(POLICY_STORE)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function expectNoCors(headers: Record<string, unknown>) {
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  }

  it('answers a preflight for /chat without CORS headers', async () => {
    // Express answers an unrouted OPTIONS itself; only the missing headers matter.
    const res = await request(app.getHttpServer())
      .options('/chat')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expectNoCors(res.headers);
  });

  it('answers a cross-origin login without CORS headers', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'nobody@example.com', password: 'wrong-password-123' });
    expectNoCors(res.headers);
  });
});
