import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { RunnableLambda } from '@langchain/core/runnables';
import { MODEL_IDS } from '../models/providers.js';
import type { EvalCase } from './dataset.js';
import { KeywordPolicySearch } from './fakes.js';
import { runCase, runCases } from './run.js';

interface Script {
  /** Next reply of the tool loop; receives the messages sent to the model. */
  turn(messages: BaseMessage[]): AIMessage | Error;
  /** Result of a structured-output call, by schema name; an Error is thrown. */
  structured(name: string, messages: BaseMessage[]): unknown;
}

/** Structured result that never arrives; the call ends only when aborted. */
const HANG = Symbol('hang');

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };

/** Scripted chat model that fires LangChain callbacks like a provider model does. */
class ScriptedModel extends BaseChatModel {
  constructor(
    private readonly script: Script,
    private readonly modelId: string,
    private readonly structuredName?: string,
    fields: BaseChatModelParams = {},
  ) {
    super(fields);
  }

  _llmType() {
    return 'scripted';
  }

  async _generate(
    messages: BaseMessage[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const reply = this.structuredName
      ? this.script.structured(this.structuredName, messages)
      : this.script.turn(messages);
    if (reply instanceof Error) throw reply;
    if (reply === HANG) {
      // Waits like a stalled provider call until the caller aborts.
      await new Promise((_, reject) =>
        options.signal?.addEventListener('abort', () =>
          reject(options.signal?.reason),
        ),
      );
    }
    const message =
      reply instanceof AIMessage
        ? reply
        : new AIMessage({ content: JSON.stringify(reply) });
    message.usage_metadata = USAGE;
    message.response_metadata = { model_name: this.modelId };
    return { generations: [{ text: String(message.content), message }] };
  }

  bindTools() {
    return this;
  }

  withStructuredOutput(_schema: unknown, config?: { name?: string }) {
    const inner = new ScriptedModel(this.script, this.modelId, config?.name);
    return RunnableLambda.from(async (input: BaseMessage[], options) =>
      JSON.parse(String((await inner.invoke(input, options)).content)),
    );
  }
}

const textOf = (messages: BaseMessage[]) =>
  messages.map((m) => String(m.content)).join('\n');
const hasToolResult = (messages: BaseMessage[]) =>
  messages.some((m) => m.getType() === 'tool');

const models = (script: Script) => ({
  cheap: new ScriptedModel(script, MODEL_IDS.openai.cheap),
  strong: new ScriptedModel(script, MODEL_IDS.openai.strong),
});

const orderCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: 'case-1',
  category: 'normal',
  customer: 'ana',
  turns: ['Where is my order ORD-1002?'],
  expect: { route: 'order', tools: ['get_order'] },
  ...overrides,
});

/** Router says "order"; the tool loop calls get_order once per turn, then answers. */
const orderScript = (seen: BaseMessage[][] = []): Script => ({
  turn: (messages) => {
    if (hasToolResult(messages)) return new AIMessage('Done looking it up.');
    const id = /ORD-\d+/.exec(String(messages.at(-1)?.content))?.[0] ?? '';
    return new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'get_order',
          args: { orderId: id },
          id: `call_${seen.length}`,
          type: 'tool_call',
        },
      ],
    });
  },
  structured: (name, messages) => {
    if (name === 'route_message') {
      seen.push(messages);
      return { intent: 'order' };
    }
    if (name === 'final_answer')
      return { answer: 'It has shipped.', orderIds: ['ORD-1002'] };
    if (name === 'remember_facts') return { facts: [] };
    throw new Error(`unexpected structured call ${name}`);
  },
});

const policies = new KeywordPolicySearch([]);

describe('runCase', () => {
  it('captures events, route, tool names and the answer in order', async () => {
    const run = await runCase(orderCase(), {
      models: models(orderScript()),
      policies,
    });

    expect(run).toMatchObject({
      id: 'case-1',
      error: null,
      route: 'order',
      toolCalls: [{ name: 'get_order', orderId: 'ORD-1002' }],
      answer: 'It has shipped.',
      refund: null,
      approvalRequired: false,
      streamOk: true,
    });
    // tool_call, token(s) and final are all counted.
    expect(run.events).toBeGreaterThanOrEqual(2);
  });

  it('runs every turn of a case in one thread', async () => {
    const routed: BaseMessage[][] = [];
    const run = await runCase(
      orderCase({ turns: ['Where is ORD-1002?', 'And what about ORD-1001?'] }),
      { models: models(orderScript(routed)), policies },
    );

    expect(run.toolCalls.map((c) => c.orderId)).toEqual([
      'ORD-1002',
      'ORD-1001',
    ]);
    // The second routing call sees the first turn as history.
    expect(textOf(routed[1])).toContain('Where is ORD-1002?');
    expect(textOf(routed[0])).not.toContain('And what about');
  });

  it('takes tokens and cost from the scripted usage of every model call', async () => {
    const run = await runCase(orderCase(), {
      models: models(orderScript()),
      policies,
    });

    // router + tool loop (2 turns) + final answer + facts + ... each call is 100/10 tokens.
    expect(run.llmCalls).toBeGreaterThanOrEqual(4);
    expect(run.inputTokens).toBe(run.llmCalls * 100);
    expect(run.outputTokens).toBe(run.llmCalls * 10);
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records a throwing model as an error and keeps running later cases', async () => {
    const script = orderScript();
    const failing: Script = {
      ...script,
      structured: (name, messages) => {
        if (name === 'route_message' && textOf(messages).includes('boom'))
          return new Error('provider exploded');
        return script.structured(name, messages);
      },
    };
    const deps = { models: models(failing), policies };

    const runs = await runCases(
      [
        orderCase({ id: 'bad', turns: ['boom ORD-1002'] }),
        orderCase({ id: 'good' }),
      ],
      deps,
    );

    expect(runs[0]).toMatchObject({
      id: 'bad',
      error: 'Error',
      route: null,
      streamOk: false,
    });
    expect(JSON.stringify(runs[0])).not.toContain('exploded');
    expect(runs[1]).toMatchObject({ id: 'good', error: null, route: 'order' });
  });

  it('records a timed-out case as an error and keeps running later cases', async () => {
    const script = orderScript();
    const stalled: Script = {
      ...script,
      structured: (name, messages) =>
        name === 'route_message' && textOf(messages).includes('stall')
          ? HANG
          : script.structured(name, messages),
    };

    const runs = await runCases(
      [
        orderCase({ id: 'slow', turns: ['stall ORD-1002'] }),
        orderCase({ id: 'fast' }),
      ],
      { models: models(stalled), policies, timeoutMs: 50 },
    );

    expect(runs[0]).toMatchObject({
      id: 'slow',
      error: 'TimeoutError',
      route: null,
      streamOk: false,
    });
    expect(runs[1]).toMatchObject({ id: 'fast', error: null, route: 'order' });
  });

  it('reuses the open refund request when the customer writes again on a paused thread', async () => {
    const refundScript: Script = {
      turn: () => new AIMessage('Noted.'),
      structured: (name) => {
        if (name === 'route_message') return { intent: 'refund' };
        if (name === 'refund_proposal')
          return {
            orderId: 'ORD-1001',
            amount: null,
            reason: 'Cracked ear cup',
          };
        if (name === 'remember_facts') return { facts: [] };
        throw new Error(`unexpected structured call ${name}`);
      },
    };
    const turn = (message: string) =>
      runCase(
        {
          ...orderCase({ turns: [message] }),
          expect: { route: 'refund', tools: [] },
        },
        { models: models(refundScript), policies },
      );

    const first = await turn('Refund ORD-1001, the ear cup is cracked.');
    const both = await runCase(
      orderCase({
        turns: [
          'Refund ORD-1001, the ear cup is cracked.',
          'Please refund ORD-1001 again, it is still cracked.',
        ],
        expect: { route: 'refund', tools: [] },
      }),
      { models: models(refundScript), policies },
    );

    // The first turn alone stores the request and pauses the thread for an operator.
    expect(first).toMatchObject({
      error: null,
      refund: { status: 'pending_approval' },
      approvalRequired: true,
    });
    // A second message on that paused thread starts a new run and reuses the open request.
    expect(both).toMatchObject({
      error: null,
      streamOk: true,
      route: 'refund',
      refund: { status: 'pending_approval' },
      approvalRequired: false,
    });
    expect(both.answer).toContain('already has a refund request');
  });
});
