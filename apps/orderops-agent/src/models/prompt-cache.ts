import { SystemMessage } from '@langchain/core/messages';
import type { Provider } from './providers.js';

const MARK = 'cacheable';

/** A stable system prompt that providers with prompt caching should cache. */
export function cacheableSystem(text: string): SystemMessage {
  return new SystemMessage({
    content: text,
    additional_kwargs: { [MARK]: true },
  });
}

const isMarked = (message: unknown): message is SystemMessage =>
  SystemMessage.isInstance(message) &&
  message.additional_kwargs?.[MARK] === true &&
  typeof message.content === 'string';

/**
 * Rewrites marked system messages for one provider; anything else is returned untouched.
 * Anthropic gets `cache_control` on the text block, Bedrock a cache point after it, and
 * every other provider the plain prompt (OpenAI caches prefixes by itself).
 */
export function forProvider(input: unknown, provider: string): unknown {
  if (!Array.isArray(input) || !input.some(isMarked)) return input;
  return input.map((message) => {
    if (!isMarked(message)) return message;
    const text = message.content as string;
    switch (provider as Provider) {
      case 'anthropic':
        return new SystemMessage({
          content: [
            { type: 'text', text, cache_control: { type: 'ephemeral' } },
          ],
        });
      case 'bedrock':
        // The Bedrock converter accepts a cache point block that core's types don't know.
        return new SystemMessage({
          content: [
            { type: 'text', text },
            { cachePoint: { type: 'default' } },
          ] as never,
        });
      default:
        return new SystemMessage(text);
    }
  });
}
