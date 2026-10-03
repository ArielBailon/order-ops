import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Annotation, START, StateGraph } from '@langchain/langgraph';
import { MODEL_IDS } from '../models/providers.js';
import { createFailoverModel } from '../models/failover.js';
import { TraceCollector } from './trace-recorder.js';

const ctx = { customerId: 'cus_ana', threadId: 't1', startedAt: 0 };

const generation = (usage: Record<string, unknown>) =>
  ({
    generations: [[{ text: '', message: { usage_metadata: usage } }]],
  }) as never;

describe('TraceCollector', () => {
  let clock = 0;
  const collector = () => new TraceCollector(() => clock);
  beforeEach(() => {
    clock = 1000;
  });

  const llm = (
    c: TraceCollector,
    runId: string,
    model: string,
    usage: Record<string, unknown>,
    ms = 250,
  ) => {
    c.handleChatModelStart({} as never, [[]], runId, undefined, undefined, [], {
      ls_model_name: model,
      ls_provider: 'anthropic',
    });
    clock += ms;
    c.handleLLMEnd(generation(usage), runId);
  };

  it('records tier, provider, tokens, latency and cost of a known model', () => {
    const c = collector();

    llm(c, 'r1', MODEL_IDS.openai.cheap, {
      input_tokens: 2_000_000,
      output_tokens: 1_000_000,
      input_token_details: { cache_read: 1_000_000 },
    });

    expect(c.calls).toEqual([
      {
        tier: 'cheap',
        provider: 'openai',
        model: MODEL_IDS.openai.cheap,
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        latencyMs: 250,
        // 1M uncached * 0.15 + 1M read * 0.075 + 1M output * 0.6
        costUsd: expect.closeTo(0.825, 6),
      },
    ]);
  });

  it('keeps an unknown model with a null cost', () => {
    const c = collector();

    llm(c, 'r1', 'mystery-model', { input_tokens: 5, output_tokens: 5 });

    expect(c.calls[0]).toMatchObject({
      tier: 'unknown',
      provider: 'anthropic',
      model: 'mystery-model',
      costUsd: null,
    });
  });

  it('drops a failed run so only completed calls are recorded', () => {
    const c = collector();
    c.handleChatModelStart({} as never, [[]], 'bad', undefined, undefined, []);
    c.handleLLMError(new Error('down'), 'bad');

    expect(c.calls).toEqual([]);
  });

  it('builds the trace from events and the abort flag', () => {
    const c = collector();
    c.note({ type: 'tool_call', data: { name: 'get_order', args: {} } });
    c.note({
      type: 'final',
      data: {
        answer: 'private text',
        orderIds: [],
        route: 'order',
        threadId: 't1',
      },
    });
    clock = 4000;

    const trace = c.toRecord(ctx, false);

    expect(trace).toMatchObject({
      route: 'order',
      tools: ['get_order'],
      status: 'ok',
      latencyMs: 4000,
    });
    expect(JSON.stringify(trace)).not.toContain('private text');
    expect(c.toRecord(ctx, true).status).toBe('aborted');
  });

  it('reports an error event as the error status', () => {
    const c = collector();
    c.note({ type: 'error', data: { code: 'agent_error', message: 'x' } });

    expect(c.toRecord(ctx, false)).toMatchObject({
      status: 'error',
      route: null,
    });
  });
});

describe('TraceCollector through the failover model in a graph', () => {
  it('receives the model call that completes, not the provider that failed over', async () => {
    const failing = {
      invoke: async () => {
        throw new Error('provider down');
      },
    };
    const working = new FakeListChatModel({ responses: ['hi'] });
    const model = createFailoverModel([
      { provider: 'anthropic', model: failing as unknown as BaseChatModel },
      { provider: 'openai', model: working as unknown as BaseChatModel },
    ]);
    const State = Annotation.Root({ done: Annotation<boolean>() });
    const graph = new StateGraph(State)
      .addNode('call', async () => {
        await (
          model as unknown as { invoke(i: unknown): Promise<unknown> }
        ).invoke('hello');
        return { done: true };
      })
      .addEdge(START, 'call')
      .compile();
    const collector = new TraceCollector();

    await graph.invoke({ done: false }, { callbacks: [collector] });

    expect(collector.calls).toHaveLength(1);
  });
});
