import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Annotation, START, StateGraph } from '@langchain/langgraph';
import { MODEL_IDS } from '../models/providers.js';
import { createFailoverModel } from '../models/failover.js';
import { summarize, TraceCollector } from './trace-recorder.js';

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

  it('counts a failover when a real chat model fails and another provider answers', async () => {
    // Chat models that report a provider and model id the way the real ones do.
    class ProviderModel extends FakeListChatModel {
      constructor(
        private readonly lsProvider: string,
        private readonly modelId: string,
        private readonly fails: boolean,
      ) {
        super({ responses: ['hi'] });
      }
      override getLsParams(options: this['ParsedCallOptions']) {
        return {
          ...super.getLsParams(options),
          ls_provider: this.lsProvider,
          ls_model_name: this.modelId,
        };
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel['_generate']>
      ) {
        if (this.fails) throw new Error('provider down');
        return super._generate(...args);
      }
    }
    const model = createFailoverModel([
      {
        provider: 'anthropic',
        model: new ProviderModel('anthropic', MODEL_IDS.anthropic.cheap, true),
      },
      {
        provider: 'openai',
        model: new ProviderModel('openai', MODEL_IDS.openai.cheap, false),
      },
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
    expect(collector.calls[0].provider).toBe('openai');
    expect(collector.toRecord(ctx, false).failovers).toBe(1);
  });
});

describe('TraceCollector id and failovers', () => {
  let clock = 0;
  const start = (
    c: TraceCollector,
    runId: string,
    model: string,
    provider: string,
  ) =>
    c.handleChatModelStart({} as never, [[]], runId, undefined, undefined, [], {
      ls_model_name: model,
      ls_provider: provider,
    });
  const fail = (
    c: TraceCollector,
    runId: string,
    model: string,
    provider: string,
  ) => {
    start(c, runId, model, provider);
    c.handleLLMError(new Error('provider down'), runId);
  };
  const succeed = (
    c: TraceCollector,
    runId: string,
    model: string,
    provider: string,
  ) => {
    start(c, runId, model, provider);
    clock += 100;
    c.handleLLMEnd(generation({ input_tokens: 10, output_tokens: 5 }), runId);
  };
  const collector = () => new TraceCollector(() => clock);

  it('generates a UUID once and puts it in every record', () => {
    const c = collector();

    expect(c.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(c.toRecord(ctx, false).id).toBe(c.id);
    expect(c.toRecord(ctx, true).id).toBe(c.id);
    expect(collector().id).not.toBe(c.id);
  });

  it('counts no failover when nothing failed', () => {
    const c = collector();
    succeed(c, 'r1', MODEL_IDS.anthropic.cheap, 'anthropic');
    succeed(c, 'r2', MODEL_IDS.anthropic.strong, 'anthropic');

    expect(c.toRecord(ctx, false).failovers).toBe(0);
  });

  it('counts a failed call answered by another provider as one failover', () => {
    const c = collector();
    fail(c, 'r1', MODEL_IDS.anthropic.strong, 'anthropic');
    succeed(c, 'r2', MODEL_IDS.openai.strong, 'openai');

    expect(c.toRecord(ctx, false).failovers).toBe(1);
    expect(c.calls).toHaveLength(1);
  });

  it('does not count a retry that the same provider answers', () => {
    const c = collector();
    fail(c, 'r1', MODEL_IDS.anthropic.cheap, 'anthropic');
    succeed(c, 'r2', MODEL_IDS.anthropic.cheap, 'anthropic');

    expect(c.toRecord(ctx, false).failovers).toBe(0);
  });

  it('counts each failover in a request', () => {
    const c = collector();
    fail(c, 'r1', MODEL_IDS.anthropic.cheap, 'anthropic');
    succeed(c, 'r2', MODEL_IDS.openai.cheap, 'openai');
    succeed(c, 'r3', MODEL_IDS.anthropic.strong, 'anthropic');
    fail(c, 'r4', MODEL_IDS.anthropic.strong, 'anthropic');
    succeed(c, 'r5', MODEL_IDS.openai.strong, 'openai');

    expect(c.toRecord(ctx, false).failovers).toBe(2);
  });

  it('does not count a failure followed by a call of an unknown provider', () => {
    const c = collector();
    fail(c, 'r1', MODEL_IDS.anthropic.cheap, 'anthropic');
    c.handleChatModelStart({} as never, [[]], 'r2', undefined, undefined, []);
    c.handleLLMEnd(generation({ input_tokens: 1, output_tokens: 1 }), 'r2');

    expect(c.toRecord(ctx, false).failovers).toBe(0);
  });
});

describe('summarize', () => {
  const call = {
    tier: 'cheap',
    provider: 'anthropic',
    model: 'm',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    latencyMs: 300,
    costUsd: 0.000125,
  };
  const record = {
    id: 'trace-1',
    customerId: 'cus_ana',
    threadId: 't1',
    route: 'order' as const,
    tools: ['get_order'],
    status: 'ok' as const,
    latencyMs: 1500,
    failovers: 1,
    calls: [
      call,
      { ...call, provider: 'openai', costUsd: 0.0005 },
      { ...call, provider: 'openai', model: 'unpriced', costUsd: null },
    ],
  };

  it('totals tokens and the priced cost, and names the last provider and model', () => {
    expect(summarize(record)).toEqual({
      id: 'trace-1',
      route: 'order',
      tools: ['get_order'],
      provider: 'openai',
      model: 'unpriced',
      failovers: 1,
      tokens: { input: 300, output: 60, cacheRead: 120, cacheWrite: 30 },
      costUsd: '0.000625',
      unpriced: 1,
      latencyMs: 1500,
      status: 'ok',
    });
  });

  it('has no provider, model or cost when no call completed', () => {
    expect(
      summarize({ ...record, status: 'error', route: null, calls: [] }),
    ).toMatchObject({
      provider: null,
      model: null,
      costUsd: null,
      unpriced: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      status: 'error',
    });
  });

  it('reports a null cost when no call had a price', () => {
    expect(
      summarize({ ...record, calls: [{ ...call, costUsd: null }] }),
    ).toMatchObject({ costUsd: null, unpriced: 1 });
  });
});
