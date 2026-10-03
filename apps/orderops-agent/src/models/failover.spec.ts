import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createFailoverModel } from './failover.js';

interface Script {
  /** Result of `invoke`, or an error to throw. */
  result?: unknown;
  /** Chunks yielded by `stream`; an Error entry throws at that point. */
  chunks?: unknown[];
}

class Fake {
  calls: string[] = [];
  constructor(
    private readonly name: string,
    private readonly script: Script,
  ) {}
  invoke = async () => {
    this.calls.push(this.name);
    if (this.script.result instanceof Error) throw this.script.result;
    return this.script.result;
  };
  stream = async () => {
    this.calls.push(this.name);
    const chunks = this.script.chunks ?? [];
    return (async function* () {
      for (const chunk of chunks) {
        if (chunk instanceof Error) throw chunk;
        yield chunk;
      }
    })();
  };
  bindTools = () => this;
  withStructuredOutput = () => this;
}

const make = (...scripts: [string, Script][]) => {
  const fakes = scripts.map(([name, script]) => new Fake(name, script));
  const model = createFailoverModel(
    fakes.map((fake, i) => ({
      provider: scripts[i][0],
      model: fake as unknown as BaseChatModel,
    })),
  );
  return { model, fakes };
};

const collect = async (stream: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe('createFailoverModel', () => {
  it('uses the first candidate and leaves the rest untouched', async () => {
    const { model, fakes } = make(
      ['a', { result: 'A' }],
      ['b', { result: 'B' }],
    );
    expect(await (model as any).invoke('x')).toBe('A');
    expect(fakes[1].calls).toEqual([]);
  });

  it('moves to the next candidate on error', async () => {
    const { model } = make(
      ['a', { result: new Error('down') }],
      ['b', { result: 'B' }],
    );
    expect(await (model as any).invoke('x')).toBe('B');
  });

  it('rethrows the last error when every candidate fails', async () => {
    const { model } = make(
      ['a', { result: new Error('first') }],
      ['b', { result: new Error('last') }],
    );
    await expect((model as any).invoke('x')).rejects.toThrow('last');
  });

  it('does not fail over after the caller aborted', async () => {
    const { model, fakes } = make(
      ['a', { result: new Error('aborted') }],
      ['b', { result: 'B' }],
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      (model as any).invoke('x', { signal: abort.signal }),
    ).rejects.toThrow('aborted');
    expect(fakes[1].calls).toEqual([]);
  });

  it('fails over structured output', async () => {
    const { model } = make(
      ['a', { result: new Error('down') }],
      ['b', { result: { intent: 'faq' } }],
    );
    const structured = model.withStructuredOutput({} as never) as any;
    expect(await structured.invoke('x')).toEqual({ intent: 'faq' });
  });

  describe('streaming with tools', () => {
    const streamOf = async (model: BaseChatModel, signal?: AbortSignal) =>
      (await (model.bindTools!([]) as any).stream('in', {
        signal,
      })) as AsyncIterable<unknown>;

    it('fails over when a stream errors before its first chunk', async () => {
      const { model } = make(
        ['a', { chunks: [new Error('down')] }],
        ['b', { chunks: ['x', 'y'] }],
      );
      expect(await collect(await streamOf(model))).toEqual(['x', 'y']);
    });

    it('propagates an error after the first chunk instead of splicing', async () => {
      const { model, fakes } = make(
        ['a', { chunks: ['x', new Error('cut off')] }],
        ['b', { chunks: ['y'] }],
      );
      await expect(collect(await streamOf(model))).rejects.toThrow('cut off');
      expect(fakes[1].calls).toEqual([]);
    });

    it('does not fail over when aborted', async () => {
      const { model, fakes } = make(
        ['a', { chunks: [new Error('aborted')] }],
        ['b', { chunks: ['y'] }],
      );
      const abort = new AbortController();
      abort.abort();
      await expect(
        collect(await streamOf(model, abort.signal)),
      ).rejects.toThrow('aborted');
      expect(fakes[1].calls).toEqual([]);
    });
  });

  it('refuses to build with no candidates', () => {
    expect(() => createFailoverModel([])).toThrow();
  });
});
