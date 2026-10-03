import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { cacheableSystem, forProvider } from './prompt-cache.js';

const messages = () => [cacheableSystem('Be brief.'), new HumanMessage('hi')];

describe('forProvider', () => {
  it('adds cache_control on the text block for Anthropic', () => {
    const [system, human] = forProvider(messages(), 'anthropic') as [
      SystemMessage,
      HumanMessage,
    ];
    expect(system.content).toEqual([
      { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(human.content).toBe('hi');
  });

  it('adds a cache point after the text for Bedrock', () => {
    const [system] = forProvider(messages(), 'bedrock') as [SystemMessage];
    expect(system.content).toEqual([
      { type: 'text', text: 'Be brief.' },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('sends the plain prompt without the marker to OpenAI', () => {
    const [system] = forProvider(messages(), 'openai') as [SystemMessage];
    expect(system.content).toBe('Be brief.');
    expect(system.additional_kwargs).toEqual({});
  });

  it('passes unmarked input through untouched', () => {
    const input = [new SystemMessage('plain'), new HumanMessage('hi')];
    expect(forProvider(input, 'anthropic')).toBe(input);
    expect(forProvider('not an array', 'bedrock')).toBe('not an array');
  });

  it('leaves unmarked messages next to a marked one as they are', () => {
    const plain = new SystemMessage('facts');
    const out = forProvider([cacheableSystem('x'), plain], 'anthropic') as [
      unknown,
      SystemMessage,
    ];
    expect(out[1]).toBe(plain);
  });
});
