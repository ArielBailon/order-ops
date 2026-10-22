import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import type { App } from 'supertest/types.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';
const TRACE_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

const item = {
  id: TRACE_ID,
  createdAt: '2026-10-22T10:00:00.000Z',
  customerId: 'cus_ana',
  threadId: 'thread-1',
  route: 'order',
  tools: ['get_order'],
  status: 'ok',
  latencyMs: 1200,
  failovers: 0,
  calls: 2,
  costUsd: '0.000300',
};

describe('observability API (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let evalDir: string;
  const summary = vi.fn();
  const listTraces = vi.fn();
  const getTrace = vi.fn();

  const tokenFor = (sub: string, role?: string) =>
    jwt.signAsync(role ? { sub, role } : { sub });
  const as = async (role: string) =>
    `Bearer ${await tokenFor(role === 'viewer' ? 'view_vic' : 'op_sam', role)}`;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    evalDir = await mkdtemp(join(tmpdir(), 'e2e-evals-'));
    await writeFile(
      join(evalDir, 'run.json'),
      JSON.stringify({
        schemaVersion: 1,
        runAt: '2026-10-20T00:00:00Z',
        gitSha: 'abc123',
        datasetSha256: 'hash-a',
        provider: 'anthropic',
        models: { cheap: 'c', strong: 's' },
        summary: { cases: 1, errors: 0 },
        cases: [{ id: 'n1', answer: 'model answer text' }],
      }),
    );
    // Imported after setting env: ConfigModule validates it when the module loads.
    const { AppModule } = await import('../src/app.module.js');
    const { EMBEDDINGS, POLICY_STORE } =
      await import('../src/faq/policy-store.js');
    const { CHECKPOINTER } = await import('../src/memory/checkpointer.js');
    const { USER_MEMORY } = await import('../src/memory/user-memory.store.js');
    const { REFUND_STORE } = await import('../src/refunds/refund.store.js');
    const { TRACE_STORE } = await import('../src/trace/trace.store.js');
    const { OBSERVABILITY_STORE } =
      await import('../src/observability/observability.store.js');
    const { EVAL_RESULTS_DIR } =
      await import('../src/observability/eval-results.js');
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
      .overrideProvider(OBSERVABILITY_STORE)
      .useValue({ summary, listTraces, getTrace })
      .overrideProvider(EVAL_RESULTS_DIR)
      .useValue(evalDir)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = new JwtService({ secret: SECRET });
  });

  afterAll(async () => {
    await app.close();
    await rm(evalDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    summary.mockReset().mockResolvedValue({ requests: 0, overall: null });
    listTraces
      .mockReset()
      .mockResolvedValue({ traces: [item], nextBefore: null });
    getTrace.mockReset().mockResolvedValue({ ...item, calls: [] });
  });

  const routes = [
    '/observability/summary',
    '/observability/traces',
    `/observability/traces/${TRACE_ID}`,
    '/observability/evals/latest',
  ];

  it.each(routes)('GET %s needs a token', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });

  it.each(routes)(
    'GET %s refuses a customer and an unknown role with 403',
    async (path) => {
      for (const make of [
        () => tokenFor('cus_ana', 'customer'),
        () => tokenFor('cus_ana'),
        () => tokenFor('cus_ana', 'Viewer'),
      ]) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${await make()}`)
          .expect(403);
      }
      expect(summary).not.toHaveBeenCalled();
      expect(listTraces).not.toHaveBeenCalled();
      expect(getTrace).not.toHaveBeenCalled();
    },
  );

  it.each(
    routes.flatMap((path) => [
      [path, 'viewer'],
      [path, 'operator'],
    ]),
  )('GET %s answers a %s', async (path, role) => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', await as(role))
      .expect(200);
  });

  it('defaults the summary window to the last 7 days and parses since', async () => {
    const auth = await as('viewer');
    await request(app.getHttpServer())
      .get('/observability/summary')
      .set('Authorization', auth)
      .expect(200);
    const [defaultSince, now] = summary.mock.calls[0] as [Date, Date];
    expect(now.getTime() - defaultSince.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );

    await request(app.getHttpServer())
      .get('/observability/summary?since=2026-10-01')
      .set('Authorization', auth)
      .expect(200);
    expect(summary.mock.calls[1][0]).toEqual(new Date('2026-10-01'));
  });

  it('parses the list query and defaults the limit to 50', async () => {
    const auth = await as('viewer');
    const res = await request(app.getHttpServer())
      .get('/observability/traces')
      .set('Authorization', auth)
      .expect(200);
    expect(listTraces).toHaveBeenLastCalledWith({ limit: 50 });
    expect(res.body).toEqual({ traces: [item], nextBefore: null });

    await request(app.getHttpServer())
      .get(
        `/observability/traces?since=2026-10-01T00:00:00Z&until=2026-10-08&route=refund&status=error&limit=10&before=${TRACE_ID}`,
      )
      .set('Authorization', auth)
      .expect(200);
    expect(listTraces).toHaveBeenLastCalledWith({
      since: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-08'),
      route: 'refund',
      status: 'error',
      limit: 10,
      before: TRACE_ID,
    });
  });

  it.each([
    ['/observability/summary?since=yesterday'],
    ['/observability/traces?since=not-a-date'],
    ['/observability/traces?until=2026-13-40'],
    ['/observability/traces?route=shipping'],
    ['/observability/traces?status=done'],
    ['/observability/traces?limit=0'],
    ['/observability/traces?limit=201'],
    ['/observability/traces?limit=ten'],
    ['/observability/traces?before=not-a-uuid'],
    ['/observability/traces/not-a-uuid'],
  ])('rejects %s with 400', async (path) => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', await as('viewer'))
      .expect(400);
    expect(summary).not.toHaveBeenCalled();
    expect(listTraces).not.toHaveBeenCalled();
    expect(getTrace).not.toHaveBeenCalled();
  });

  it('answers 400 for an unknown before cursor', async () => {
    listTraces.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get(`/observability/traces?before=${TRACE_ID}`)
      .set('Authorization', await as('viewer'))
      .expect(400);
    expect(res.body.message).toEqual(['before: unknown trace id']);
  });

  it('answers 404 for an unknown trace', async () => {
    getTrace.mockResolvedValue(null);

    await request(app.getHttpServer())
      .get(`/observability/traces/${TRACE_ID}`)
      .set('Authorization', await as('operator'))
      .expect(404);
    expect(getTrace).toHaveBeenCalledWith(TRACE_ID);
  });

  it('serves the latest eval run per provider without per-case answers', async () => {
    const res = await request(app.getHttpServer())
      .get('/observability/evals/latest')
      .set('Authorization', await as('viewer'))
      .expect(200);

    expect(res.body).toEqual({
      providers: [
        {
          schemaVersion: 1,
          runAt: '2026-10-20T00:00:00Z',
          gitSha: 'abc123',
          datasetSha256: 'hash-a',
          provider: 'anthropic',
          models: { cheap: 'c', strong: 's' },
          summary: { cases: 1, errors: 0 },
          judge: null,
          caseCount: 1,
        },
      ],
      comparable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('model answer text');
  });

  it('answers 500 without the file content when a result file is malformed', async () => {
    const broken = join(evalDir, 'broken.json');
    await writeFile(broken, '{ "secret": "leak-me", ');
    try {
      const res = await request(app.getHttpServer())
        .get('/observability/evals/latest')
        .set('Authorization', await as('viewer'))
        .expect(500);
      expect(JSON.stringify(res.body)).not.toContain('leak-me');
    } finally {
      await rm(broken);
    }
  });
});
