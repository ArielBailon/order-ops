import { Document } from '@langchain/core/documents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import {
  FAQ_TOP_K,
  FaqService,
  NO_POLICY_ANSWER,
  type PolicySearch,
} from './faq.service.js';

const chunk = new Document({
  pageContent: 'Returns: 30 days from delivery.',
  metadata: { source: 'returns', section: 'Return window' },
});

describe('FaqService', () => {
  const signal = new AbortController().signal;
  const search = vi.fn<PolicySearch['similaritySearch']>();
  const inputs: BaseMessage[][] = [];
  let results: unknown[];

  const model = {
    withStructuredOutput: () => ({
      invoke: async (messages: BaseMessage[]) => {
        inputs.push(messages);
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  } as unknown as BaseChatModel;
  const service = () => new FaqService(model, { similaritySearch: search });

  beforeEach(() => {
    search.mockReset();
    inputs.length = 0;
    results = [];
  });

  it('answers from the retrieved chunks with no order ids', async () => {
    search.mockResolvedValue([chunk]);
    results = [{ answer: 'You have 30 days.' }];

    const answer = await service().answer(
      'how long do I have to return?',
      signal,
    );

    expect(answer).toEqual({ answer: 'You have 30 days.', orderIds: [] });
    expect(search).toHaveBeenCalledWith(
      'how long do I have to return?',
      FAQ_TOP_K,
    );
    const prompt = String(inputs[0].at(-1)?.content);
    expect(prompt).toContain('[returns / Return window]');
    expect(prompt).toContain('30 days from delivery');
  });

  it('returns the fixed answer without calling the model when nothing is retrieved', async () => {
    search.mockResolvedValue([]);

    const answer = await service().answer('anything', signal);

    expect(answer).toEqual({ answer: NO_POLICY_ANSWER, orderIds: [] });
    expect(inputs).toHaveLength(0);
  });

  it('retries invalid structured output once, then fails with invalid_output', async () => {
    search.mockResolvedValue([chunk]);
    results = [new OutputParserException('bad'), { answer: 'ok' }];
    await expect(service().answer('q', signal)).resolves.toMatchObject({
      answer: 'ok',
    });

    results = [{ answer: '' }, new OutputParserException('bad')];
    await expect(service().answer('q', signal)).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('propagates a vector store failure without calling the model', async () => {
    search.mockRejectedValue(new Error('db down'));

    await expect(service().answer('q', signal)).rejects.toThrow('db down');
    expect(inputs).toHaveLength(0);
  });
});
