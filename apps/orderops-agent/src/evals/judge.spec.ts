import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { judgeAnswer, RUBRIC } from './judge.js';

const input = {
  turns: ['Where is ORD-1002?'],
  answer: 'It shipped.',
  toolResults: ['{"id":"ORD-1002","status":"shipped"}'],
};

/** Stand-in for a chat model whose structured-output runnable runs `reply`. */
const modelReplying = (reply: (messages: BaseMessage[]) => unknown) =>
  ({
    withStructuredOutput: () =>
      RunnableLambda.from(async (messages: BaseMessage[]) => reply(messages)),
  }) as unknown as BaseChatModel;

describe('judgeAnswer', () => {
  it('passes only when every criterion holds', async () => {
    const all = { relevant: true, grounded: true, appropriate: true };
    expect(
      await judgeAnswer(
        modelReplying(() => all),
        input,
      ),
    ).toMatchObject({
      verdict: all,
      pass: true,
    });
    expect(
      await judgeAnswer(
        modelReplying(() => ({ ...all, grounded: false })),
        input,
      ),
    ).toMatchObject({ pass: false });
  });

  it('sends the rubric, the customer turns, the tool results and the answer', async () => {
    let seen: BaseMessage[] = [];
    await judgeAnswer(
      modelReplying((messages) => {
        seen = messages;
        return { relevant: true, grounded: true, appropriate: true };
      }),
      input,
    );
    expect(String(seen[0].content)).toBe(RUBRIC);
    const body = String(seen[1].content);
    expect(body).toContain('Where is ORD-1002?');
    expect(body).toContain('"status":"shipped"');
    expect(body).toContain('It shipped.');
  });

  it('leaves the case unjudged on malformed output', async () => {
    const outcome = await judgeAnswer(
      modelReplying(() => ({ relevant: 'yes' })),
      input,
    );
    expect(outcome).toMatchObject({ verdict: null, pass: null });
  });

  it('leaves the case unjudged when the model throws', async () => {
    const outcome = await judgeAnswer(
      modelReplying(() => {
        throw new Error('provider exploded');
      }),
      input,
    );
    expect(outcome).toMatchObject({ verdict: null, pass: null });
  });
});
