import { Logger } from '@nestjs/common';
import type { TraceStore } from '../trace/trace.store.js';

export const DAILY_BUDGET = Symbol('DAILY_BUDGET');

/** Sent as the `final` answer (route `budget`) once the day's budget is used up; never model output. */
export const BUDGET_REPLY =
  'The OrderOps demo has reached its daily usage limit, so the assistant is paused until 00:00 UTC. Please try again after that.';

/** 00:00:00.000 UTC of the day that contains `now`: the budget window starts here. */
export function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Spend guard for the public demo: today's estimated chat cost (from the stored traces) against
 * a USD cap. Requests already running when the cap is crossed still finish, so the cap can be
 * exceeded by their cost; unpriced calls count as 0.
 */
export class DailyBudget {
  private readonly logger = new Logger(DailyBudget.name);

  constructor(
    private readonly capUsd: number,
    private readonly traces: Pick<TraceStore, 'costSince'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exceeded(): Promise<boolean> {
    try {
      const spent = await this.traces.costSince(utcDayStart(this.now()));
      return spent >= this.capUsd;
    } catch (error) {
      // Fail closed: the guard protects money, and without the spend we cannot tell it is safe.
      this.logger.warn(`budget check failed: ${(error as Error).name}`);
      return true;
    }
  }
}

/** The budget from `DAILY_BUDGET_USD`, or null when it is unset (no budget, no query). */
export function dailyBudgetFromEnv(
  capUsd: number | undefined,
  traces: Pick<TraceStore, 'costSince'>,
): DailyBudget | null {
  return capUsd === undefined ? null : new DailyBudget(capUsd, traces);
}
