import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import { DAILY_BUDGET } from '../src/chat/daily-budget.js';
import { CHAT_RATE_LIMIT, FixedWindowLimiter } from '../src/chat/rate-limit.js';
import { CHECKPOINTER } from '../src/memory/checkpointer.js';
import { CHEAP_MODEL, STRONG_MODEL } from '../src/models/models.module.js';
import { USER_MEMORY } from '../src/memory/user-memory.store.js';
import { REFUND_STORE } from '../src/refunds/refund.store.js';
import { TRACE_STORE } from '../src/trace/trace.store.js';
import { EMBEDDINGS, POLICY_STORE } from '../src/faq/policy-store.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('gateway chat rate limit (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const record = vi.fn();
  const exceeded = vi.fn(async () => true);
  const model = {
    bindTools: () => {
      throw new Error('model must not be called');
    },
    withStructuredOutput: () => {
      throw new Error('model must not be called');
    },
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('orders must not be called');
      }),
    );
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CHEAP_MODEL)
      .useValue(model)
      .overrideProvider(STRONG_MODEL)
      .useValue(model)
      .overrideProvider(CHECKPOINTER)
      .useValue(new MemorySaver())
      .overrideProvider(TRACE_STORE)
      .useValue({ record })
      // The allowed request gets the fixed budget reply, so no model is needed to reach the limit.
      .overrideProvider(DAILY_BUDGET)
      .useValue({ exceeded })
      .overrideProvider(CHAT_RATE_LIMIT)
      .useValue(new FixedWindowLimiter(1, 60_000))
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
    jwt = new JwtService({ secret: SECRET });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('answers 429 with Retry-After past the limit, without running the agent', async () => {
    const ana = await jwt.signAsync({ sub: 'cus_ana' });
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${ana}`)
      .send({ message: 'where is ord_1001?' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(exceeded).toHaveBeenCalledTimes(1);

    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${ana}`)
      .send({ message: 'and ord_1002?' })
      .expect(429)
      .expect('Content-Type', /application\/json/);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    const seconds = Number(res.headers['retry-after']);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(res.body).toEqual({
      statusCode: 429,
      message: `Too many chat messages. Try again in ${seconds} seconds.`,
    });
    // The refused request never reached the agent: no budget check, no trace.
    expect(exceeded).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('counts each customer on its own', async () => {
    const ben = await jwt.signAsync({ sub: 'cus_ben' });
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${ben}`)
      .send({ message: 'where is ord_2001?' })
      .expect(200);
  });

  it('does not count a request refused for its body', async () => {
    const cora = await jwt.signAsync({ sub: 'cus_cora' });
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${cora}`)
      .send({ message: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${cora}`)
      .send({ message: 'where is ord_3001?' })
      .expect(200);
  });
});
