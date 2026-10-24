import {
  DailyBudget,
  dailyBudgetFromEnv,
  utcDayStart,
} from './daily-budget.js';

describe('utcDayStart', () => {
  it.each([
    ['2026-10-23T15:42:10.123Z', '2026-10-23T00:00:00.000Z'],
    ['2026-10-23T00:00:00.001Z', '2026-10-23T00:00:00.000Z'],
    ['2026-10-23T23:59:59.999Z', '2026-10-23T00:00:00.000Z'],
    ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ])('starts the window of %s at %s', (now, start) => {
    expect(utcDayStart(new Date(now)).toISOString()).toBe(start);
  });
});

describe('DailyBudget', () => {
  const costSince = vi.fn<(since: Date) => Promise<number>>();
  const now = () => new Date('2026-10-23T15:42:10Z');
  const budget = new DailyBudget(2, { costSince }, now);

  beforeEach(() => costSince.mockReset());

  it('asks for the spend since 00:00 UTC today', async () => {
    costSince.mockResolvedValue(0.5);

    await budget.exceeded();

    expect(costSince).toHaveBeenCalledWith(new Date('2026-10-23T00:00:00Z'));
  });

  it.each([
    [1.999999, false],
    [2, true],
    [3.5, true],
  ])('treats a spend of %d as exceeded: %s', async (spent, expected) => {
    costSince.mockResolvedValue(spent);

    expect(await budget.exceeded()).toBe(expected);
  });

  it('counts a failing spend query as exceeded (fail closed)', async () => {
    // A plain function: the caught rejection must not be tracked by a mock.
    const failing = new DailyBudget(
      2,
      {
        costSince: async () => {
          throw new Error('db down');
        },
      },
      now,
    );

    expect(await failing.exceeded()).toBe(true);
  });
});

describe('dailyBudgetFromEnv', () => {
  it('is null without a cap and a budget with one', () => {
    const traces = { costSince: vi.fn() };

    expect(dailyBudgetFromEnv(undefined, traces)).toBeNull();
    expect(dailyBudgetFromEnv(2, traces)).toBeInstanceOf(DailyBudget);
    expect(traces.costSince).not.toHaveBeenCalled();
  });
});
