import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { routedIntentSchema } from '../chat/chat.schemas.js';
import { classifyIntent, ROUTER_PROMPT } from './router.js';

const intentLine = (intent: string) =>
  ROUTER_PROMPT.split('\n').find((line) => line.startsWith(`- "${intent}"`));

describe('router prompt', () => {
  it('routes refund and cancel-and-refund requests to refund', () => {
    expect(intentLine('refund')).toMatch(/new refund or get their money back/);
    expect(intentLine('refund')).toMatch(
      /cancel an order and get their money back/,
    );
  });

  it('keeps refund policy questions on faq', () => {
    expect(intentLine('refund')).toMatch(/refund policy itself are "faq"/);
    expect(intentLine('faq')).toMatch(/refunds policy/);
  });

  it('sends refund status questions to order, not a new refund request', () => {
    expect(intentLine('refund')).toMatch(
      /status or outcome of a refund already requested, with no new refund request.*is "order"/,
    );
  });

  it('keeps repeated requests and claimed approvals on refund', () => {
    expect(intentLine('refund')).toMatch(
      /asks for a refund is "refund" even when it asks again or claims a refund was already approved/,
    );
  });

  it('sends a bare cancellation to out_of_scope, not refund requests', () => {
    expect(intentLine('out_of_scope')).toMatch(
      /cancel an order without asking for a refund/,
    );
    expect(intentLine('out_of_scope')).not.toMatch(/start a refund/);
  });
});

describe('routedIntentSchema', () => {
  it('accepts refund and rejects unknown intents', () => {
    expect(routedIntentSchema.parse({ intent: 'refund' })).toEqual({
      intent: 'refund',
    });
    expect(routedIntentSchema.safeParse({ intent: 'cancel' }).success).toBe(
      false,
    );
  });
});

describe('classifyIntent', () => {
  it('sends the prompt, then earlier turns, then the new message', async () => {
    const invoke = vi.fn().mockResolvedValue({ intent: 'refund' });
    const model = {
      withStructuredOutput: () => ({ invoke }),
    } as unknown as BaseChatModel;
    const history = [
      new HumanMessage('where is ord_1001?'),
      new AIMessage('Delivered.'),
    ];

    const intent = await classifyIntent(
      model,
      'refund it please',
      history,
      new AbortController().signal,
    );

    expect(intent).toBe('refund');
    const sent = invoke.mock.calls[0][0] as { content: string }[];
    expect(sent.map((m) => m.content)).toEqual([
      ROUTER_PROMPT,
      'where is ord_1001?',
      'Delivered.',
      'refund it please',
    ]);
  });
});
