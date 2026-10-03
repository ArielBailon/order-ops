import { costUsd, PRICES, usageOf } from './pricing.js';
import { MODEL_IDS } from './providers.js';

const SONNET = MODEL_IDS.anthropic.strong;

describe('costUsd', () => {
  it('prices uncached input, cache read, cache write and output separately', () => {
    // 1M total input = 500k uncached + 300k read + 200k written, 100k output.
    const cost = costUsd(SONNET, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 200_000,
    });
    // 0.5*3 + 0.3*0.3 + 0.2*3.75 + 0.1*15
    expect(cost).toBeCloseTo(1.5 + 0.09 + 0.75 + 1.5, 6);
  });

  it('does not double count cached tokens', () => {
    const plain = { outputTokens: 0, cacheWriteTokens: 0 };
    const cached = costUsd(SONNET, {
      ...plain,
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cached).toBeCloseTo(0.3, 6);
  });

  it('returns null for an unknown model', () => {
    expect(
      costUsd('mystery-model', {
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it('has a price for every model id the provider layer can build', () => {
    for (const tiers of Object.values(MODEL_IDS))
      for (const id of Object.values(tiers)) expect(PRICES[id]).toBeDefined();
  });
});

describe('usageOf', () => {
  it('reads tokens and cache details from usage_metadata', () => {
    expect(
      usageOf({
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        input_token_details: { cache_read: 80, cache_creation: 10 },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });

  it('returns zeros when usage is missing', () => {
    expect(usageOf(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
