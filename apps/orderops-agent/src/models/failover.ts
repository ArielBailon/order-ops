import { Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface Candidate {
  provider: string;
  model: BaseChatModel;
}

interface CallOptions {
  signal?: AbortSignal;
}

interface Callable {
  invoke(input: unknown, options?: CallOptions): Promise<unknown>;
  stream?(
    input: unknown,
    options?: CallOptions,
  ): Promise<AsyncIterable<unknown>>;
}

interface Entry {
  provider: string;
  runnable: Callable;
}

const logger = new Logger('ModelFailover');

/**
 * Chat model that tries each candidate in order. A call moves to the next candidate when
 * the current one throws, except after the caller aborted. A stream moves on only before
 * its first chunk, so a partial answer is never spliced across providers.
 * Only the surface the graph uses is provided: `invoke`, `bindTools(...).stream` and
 * `withStructuredOutput(...).invoke`.
 */
export function createFailoverModel(candidates: Candidate[]): BaseChatModel {
  if (candidates.length === 0)
    throw new Error('No chat model provider is enabled');
  const entries = (bind: (model: BaseChatModel) => unknown): Entry[] =>
    candidates.map(({ provider, model }) => ({
      provider,
      runnable: bind(model) as Callable,
    }));

  const model = {
    ...failover(entries((m) => m)),
    bindTools: (...args: Parameters<NonNullable<BaseChatModel['bindTools']>>) =>
      failover(entries((m) => m.bindTools?.(...args))),
    withStructuredOutput: (
      ...args: Parameters<BaseChatModel['withStructuredOutput']>
    ) => failover(entries((m) => m.withStructuredOutput(...args))),
  };
  // Callers only use the members above; the rest of BaseChatModel is not needed.
  return model as unknown as BaseChatModel;
}

function failover(entries: Entry[]) {
  /** Logs the failure and reports whether the next entry should be tried. */
  const next = (index: number, error: unknown, signal?: AbortSignal) => {
    if (signal?.aborted || index === entries.length - 1) return false;
    logger.warn(
      `${entries[index].provider} failed (${(error as Error).name}); trying ${entries[index + 1].provider}`,
    );
    return true;
  };

  return {
    async invoke(input: unknown, options?: CallOptions) {
      for (let i = 0; ; i++) {
        try {
          return await entries[i].runnable.invoke(input, options);
        } catch (error) {
          if (!next(i, error, options?.signal)) throw error;
        }
      }
    },
    async stream(input: unknown, options?: CallOptions) {
      return (async function* () {
        for (let i = 0; ; i++) {
          let yielded = false;
          try {
            const stream = await entries[i].runnable.stream!(input, options);
            for await (const chunk of stream) {
              yielded = true;
              yield chunk;
            }
            return;
          } catch (error) {
            if (yielded || !next(i, error, options?.signal)) throw error;
          }
        }
      })();
    },
  };
}
