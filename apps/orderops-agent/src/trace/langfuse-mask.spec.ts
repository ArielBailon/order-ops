import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Annotation, START, StateGraph } from '@langchain/langgraph';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  errorType,
  METADATA_ALLOWLIST,
  REDACTED,
  scrubAttributes,
} from './langfuse-mask.js';
import { createLangfuseTracing, langfuseTraceId } from './langfuse.js';

const SECRET_MESSAGE = 'SECRET-MESSAGE where is my kettle';
const SECRET_OUTPUT = 'SECRET-OUTPUT your kettle shipped';
const SECRET_TOKEN = 'SECRET-TOKEN.eyJhbGciOiJIUzI1NiJ9';
const SECRET_ERROR = 'SECRET-ERROR raw model text';
const SECRETS = [
  SECRET_MESSAGE,
  SECRET_OUTPUT,
  SECRET_TOKEN,
  SECRET_ERROR,
  'SECRET',
];

describe('scrubAttributes', () => {
  it.each([
    ['a string', JSON.stringify(SECRET_MESSAGE)],
    [
      'a message array',
      JSON.stringify([{ role: 'user', content: SECRET_MESSAGE }]),
    ],
    [
      'a chain object',
      JSON.stringify({ message: SECRET_MESSAGE, orderId: 'ord_1' }),
    ],
    ['a tool argument', JSON.stringify({ orderId: SECRET_MESSAGE })],
  ])('replaces inputs and outputs holding %s', (_label, value) => {
    const scrubbed = scrubAttributes({
      'langfuse.observation.input': value,
      'langfuse.observation.output': value,
      'langfuse.trace.input': value,
      'langfuse.trace.output': value,
    });

    expect(Object.values(scrubbed)).toEqual(
      Array(4).fill(JSON.stringify(REDACTED)),
    );
    expect(JSON.stringify(scrubbed)).not.toContain('SECRET');
  });

  it('keeps allowlisted metadata and drops every other key, including the token', () => {
    const scrubbed = scrubAttributes({
      'langfuse.observation.metadata.langgraph_node': '"agent"',
      'langfuse.observation.metadata.ls_model_name': '"claude-haiku"',
      'langfuse.observation.metadata.token': JSON.stringify(SECRET_TOKEN),
      'langfuse.observation.metadata.customerId': '"cus_ana"',
      'langfuse.observation.metadata': JSON.stringify({ token: SECRET_TOKEN }),
      'langfuse.trace.metadata.token': JSON.stringify(SECRET_TOKEN),
    });

    expect(scrubbed).toEqual({
      'langfuse.observation.metadata.langgraph_node': '"agent"',
      'langfuse.observation.metadata.ls_model_name': '"claude-haiku"',
    });
    expect([...METADATA_ALLOWLIST]).not.toContain('token');
  });

  it('keeps model, usage, timing, level and ids, and reduces the error to its type', () => {
    const kept = {
      'langfuse.observation.type': 'generation',
      'langfuse.observation.model.name': 'claude-haiku',
      'langfuse.observation.usage_details': '{"input":10,"output":5}',
      'langfuse.observation.completion_start_time':
        '"2026-10-22T10:00:00.000Z"',
      'langfuse.observation.level': 'ERROR',
      'session.id': 'thread-1',
      'user.id': 'cus_ana',
    };

    const scrubbed = scrubAttributes({
      ...kept,
      'langfuse.observation.status_message': `OutputParserException: ${SECRET_ERROR}`,
      'gen_ai.prompt': SECRET_MESSAGE,
    });

    expect(scrubbed).toEqual({
      ...kept,
      'langfuse.observation.status_message': 'OutputParserException',
    });
  });

  it.each([
    ['ZodError: arg orderId was SECRET', 'ZodError'],
    ['Error', 'Error'],
    [`${SECRET_ERROR} without a name`, 'Error'],
    [undefined, 'Error'],
  ])('reduces %j to %s', (message, expected) => {
    expect(errorType(message)).toBe(expected);
  });
});

describe('Langfuse spans through the real handler and processor', () => {
  // The real Langfuse processor with its network exporter swapped for an in-memory one.
  const exporter = new InMemorySpanExporter();
  const tracing = createLangfuseTracing(
    new LangfuseSpanProcessor({
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      exporter,
      exportMode: 'immediate',
      mediaUploadEnabled: false,
    }),
  );
  let spans: ReadableSpan[] = [];
  const CHAT_TRACE_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

  const runGraph = async (model: FakeListChatModel) => {
    const State = Annotation.Root({ done: Annotation<boolean>() });
    const graph = new StateGraph(State)
      .addNode('agent', async () => {
        await model.invoke([new HumanMessage(SECRET_MESSAGE)]);
        return { done: true };
      })
      .addEdge(START, 'agent')
      .compile();
    const handler = tracing.handlerFor(CHAT_TRACE_ID, {
      sessionId: 'thread-1',
      userId: 'cus_ana',
    });
    await graph
      .invoke(
        { done: false },
        {
          callbacks: [handler],
          configurable: {
            token: SECRET_TOKEN,
            customerId: 'cus_ana',
            thread_id: 'cus_ana:thread-1',
          },
        },
      )
      .catch(() => undefined);
    await awaitAllCallbacks();
    await tracing.flush();
    spans = exporter.getFinishedSpans();
  };

  const everything = () =>
    JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );

  beforeEach(() => {
    exporter.reset();
    spans = [];
  });

  it('puts every span of the run under the ChatTrace id and sends no text or token', async () => {
    await runGraph(new FakeListChatModel({ responses: [SECRET_OUTPUT] }));

    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const span of spans)
      expect(span.spanContext().traceId).toBe(langfuseTraceId(CHAT_TRACE_ID));
    expect(langfuseTraceId(CHAT_TRACE_ID)).toBe(
      '7f1c2a9e3b4d4e5f8a6b1c2d3e4f5a6b',
    );
    for (const secret of SECRETS) expect(everything()).not.toContain(secret);
    const generation = spans.find(
      (s) => s.attributes['langfuse.observation.type'] === 'generation',
    );
    expect(generation).toBeDefined();
    expect(generation?.attributes['langfuse.observation.input']).toBe(
      JSON.stringify(REDACTED),
    );
    expect(
      spans.some(
        (s) => s.attributes['langfuse.observation.metadata.langgraph_node'],
      ),
    ).toBe(true);
    expect(spans.some((s) => s.attributes['user.id'] === 'cus_ana')).toBe(true);
  });

  it('keeps the error type but not the error text of a failing model call', async () => {
    class FailingModel extends FakeListChatModel {
      override async _generate(): Promise<never> {
        throw new TypeError(SECRET_ERROR);
      }
    }

    await runGraph(new FailingModel({ responses: [] }));

    for (const secret of SECRETS) expect(everything()).not.toContain(secret);
    expect(
      spans.some(
        (s) =>
          s.attributes['langfuse.observation.status_message'] === 'TypeError',
      ),
    ).toBe(true);
  });
});
