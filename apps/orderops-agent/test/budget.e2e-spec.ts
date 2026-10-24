import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import { BUDGET_REPLY, DAILY_BUDGET } from '../src/chat/daily-budget.js';
import { CHECKPOINTER } from '../src/memory/checkpointer.js';
import { CHEAP_MODEL, STRONG_MODEL } from '../src/models/models.module.js';
import { USER_MEMORY } from '../src/memory/user-memory.store.js';
import { REFUND_STORE } from '../src/refunds/refund.store.js';
import { TRACE_STORE } from '../src/trace/trace.store.js';
import { EMBEDDINGS, POLICY_STORE } from '../src/faq/policy-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('gateway chat with the daily budget used up (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const record = vi.fn();
  // Any model or orders call would be a bug: the fixed reply must come before the graph.
  const model = {
    bindTools: () => {
      throw new Error('model must not be called');
    },
    withStructuredOutput: () => {
      throw new Error('model must not be called');
    },
  };
  const fetchMock = vi.fn(async () => {
    throw new Error('orders must not be called');
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    vi.stubGlobal('fetch', fetchMock);
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
      .overrideProvider(DAILY_BUDGET)
      .useValue({ exceeded: async () => true })
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
    token = await new JwtService({ secret: SECRET }).signAsync({
      sub: 'cus_ana',
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('streams the fixed reply with route budget and stores the trace', async () => {
    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'where is ord_1001?' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = res.text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return {
          type: eventLine.replace('event: ', ''),
          data: JSON.parse(dataLine.replace('data: ', '')),
        };
      });
    expect(events).toEqual([
      {
        type: 'final',
        data: {
          answer: BUDGET_REPLY,
          orderIds: [],
          route: 'budget',
          threadId: expect.stringMatching(UUID),
        },
      },
      {
        type: 'trace',
        data: expect.objectContaining({
          id: expect.stringMatching(UUID),
          route: 'budget',
          tools: [],
          status: 'ok',
        }),
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({
      route: 'budget',
      calls: [],
    });
  });
});
