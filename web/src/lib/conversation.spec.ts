import { describe, expect, it } from 'vitest';
import {
  type AssistantMessage,
  type ChatEvent,
  type Conversation,
  conversationReducer,
  emptyConversation,
  toChatEvent,
  type TraceSummary,
} from './conversation';

const THREAD = '3e833860-4d78-4152-a1a8-64e32bebbc11';

const trace: TraceSummary = {
  id: 'aae823c7-709b-418d-b90a-5796de6f4c09',
  route: 'order',
  tools: ['list_orders'],
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  failovers: 0,
  tokens: { input: 5832, output: 323, cacheRead: 0, cacheWrite: 0 },
  costUsd: '0.017915',
  unpriced: 0,
  latencyMs: 5890,
  status: 'ok',
};

function run(events: ChatEvent[], start: Conversation = emptyConversation) {
  let state = conversationReducer(start, {
    type: 'send',
    userId: 'u1',
    assistantId: 'a1',
    text: 'Where is my order?',
  });
  for (const event of events)
    state = conversationReducer(state, {
      type: 'event',
      assistantId: 'a1',
      event,
    });
  return state;
}

const reply = (state: Conversation) =>
  state.messages.at(-1) as AssistantMessage;

describe('toChatEvent', () => {
  it('parses known events and ignores unknown types and bad JSON', () => {
    expect(toChatEvent({ event: 'token', data: '{"text":"Hi"}' })).toEqual({
      type: 'token',
      data: { text: 'Hi' },
    });
    expect(toChatEvent({ event: 'ping', data: '{}' })).toBeNull();
    expect(toChatEvent({ event: 'token', data: 'not json' })).toBeNull();
  });
});

describe('conversationReducer', () => {
  it('adds the question and a streaming reply', () => {
    const state = run([]);

    expect(state.messages).toEqual([
      { id: 'u1', role: 'user', text: 'Where is my order?' },
      { id: 'a1', role: 'assistant', text: '', status: 'streaming', tools: [] },
    ]);
  });

  it('streams tokens and tool calls into the reply', () => {
    const state = run([
      { type: 'tool_call', data: { name: 'list_orders', args: {} } },
      { type: 'token', data: { text: 'Your order ' } },
      { type: 'token', data: { text: 'shipped' } },
    ]);

    expect(reply(state)).toMatchObject({
      text: 'Your order shipped',
      tools: ['list_orders'],
      status: 'streaming',
    });
  });

  it('replaces the streamed text with the final answer and keeps the thread id', () => {
    const state = run([
      { type: 'token', data: { text: 'Your order' } },
      {
        type: 'final',
        data: {
          answer: 'Your order shipped.',
          route: 'order',
          threadId: THREAD,
        },
      },
    ]);

    expect(reply(state)).toMatchObject({
      text: 'Your order shipped.',
      status: 'done',
    });
    expect(state.threadId).toBe(THREAD);
  });

  it('keeps the approval notice of a refund waiting for an operator', () => {
    const state = run([
      {
        type: 'approval_required',
        data: { refundId: 'r1', orderId: 'ord_1001', amount: '89.90' },
      },
      {
        type: 'final',
        data: {
          answer: 'Sent for approval.',
          route: 'refund',
          threadId: THREAD,
        },
      },
    ]);

    expect(reply(state).approval).toEqual({
      refundId: 'r1',
      orderId: 'ord_1001',
      amount: '89.90',
    });
  });

  it('marks the reply failed with the error message', () => {
    const state = run([
      {
        type: 'error',
        data: { code: 'agent_error', message: 'Please try again.' },
      },
    ]);

    expect(reply(state)).toMatchObject({
      status: 'failed',
      error: 'Please try again.',
    });
  });

  it('fills the timeline from the trace event, including an unpriced reply', () => {
    const unpriced = { ...trace, costUsd: null, unpriced: 2 };
    const state = run([
      {
        type: 'final',
        data: { answer: 'Done.', route: 'order', threadId: THREAD },
      },
      { type: 'trace', data: unpriced },
    ]);

    expect(reply(state)).toMatchObject({ status: 'done', trace: unpriced });
  });

  it('marks a reply cut off before final as interrupted', () => {
    const state = conversationReducer(
      run([{ type: 'token', data: { text: 'Your' } }]),
      {
        type: 'end',
        assistantId: 'a1',
      },
    );

    expect(reply(state)).toMatchObject({ status: 'interrupted', text: 'Your' });
  });

  it('leaves a finished reply alone when the stream ends', () => {
    const done = run([
      {
        type: 'final',
        data: { answer: 'Done.', route: 'order', threadId: THREAD },
      },
    ]);

    expect(
      reply(conversationReducer(done, { type: 'end', assistantId: 'a1' }))
        .status,
    ).toBe('done');
  });

  it('marks a request that failed outright as failed', () => {
    const state = conversationReducer(run([]), {
      type: 'fail',
      assistantId: 'a1',
      message: 'The agent is not reachable right now.',
    });

    expect(reply(state)).toMatchObject({
      status: 'failed',
      error: 'The agent is not reachable right now.',
    });
  });

  it('starts over on reset', () => {
    const state = run([
      {
        type: 'final',
        data: { answer: 'Done.', route: 'order', threadId: THREAD },
      },
    ]);

    expect(conversationReducer(state, { type: 'reset' })).toEqual(
      emptyConversation,
    );
  });
});

describe('watching refund requests', () => {
  const approval: ChatEvent = {
    type: 'approval_required',
    data: { refundId: 'ref_1', orderId: 'ord_1001', amount: '89.90' },
  };
  const final = (refund?: {
    id: string;
    status: 'pending_approval' | 'auto_rejected';
  }): ChatEvent => ({
    type: 'final',
    data: { answer: 'Noted.', route: 'refund', threadId: THREAD, refund },
  });
  const decided = (refundId = 'ref_1') =>
    ({
      type: 'refund_decided',
      refundId,
      updateId: 'op1',
      text: 'Update on refund request ref_1: our team approved your refund.',
    }) as const;

  it('watches the request named by approval_required once', () => {
    const state = run([
      approval,
      final({ id: 'ref_1', status: 'pending_approval' }),
    ]);

    expect(state.watching).toEqual(['ref_1']);
    expect(reply(state).refund).toEqual({
      id: 'ref_1',
      status: 'pending_approval',
    });
  });

  it('watches an open request the agent reused, with no approval_required event', () => {
    expect(
      run([final({ id: 'ref_9', status: 'pending_approval' })]).watching,
    ).toEqual(['ref_9']);
  });

  it('does not watch an auto-rejected request or a reply without a refund', () => {
    expect(
      run([final({ id: 'ref_2', status: 'auto_rejected' })]).watching,
    ).toEqual([]);
    expect(run([final()]).watching).toEqual([]);
  });

  it('adds exactly one operator update when the request is decided, then stops watching', () => {
    const watched = run([approval]);
    const once = conversationReducer(watched, decided());
    const twice = conversationReducer(once, decided());

    expect(once.watching).toEqual([]);
    expect(once.messages.at(-1)).toEqual({
      id: 'op1',
      role: 'operator',
      refundId: 'ref_1',
      text: 'Update on refund request ref_1: our team approved your refund.',
    });
    expect(twice).toBe(once);
  });

  it('ignores a decision for a request it does not watch', () => {
    const state = run([]);

    expect(conversationReducer(state, decided('ref_other'))).toBe(state);
  });

  it('stops watching quietly when the request is gone', () => {
    const state = conversationReducer(run([approval]), {
      type: 'refund_unwatched',
      refundId: 'ref_1',
    });

    expect(state.watching).toEqual([]);
    expect(state.messages.some((m) => m.role === 'operator')).toBe(false);
  });

  it('clears the watched requests on reset', () => {
    expect(
      conversationReducer(run([approval]), { type: 'reset' }).watching,
    ).toEqual([]);
  });
});
