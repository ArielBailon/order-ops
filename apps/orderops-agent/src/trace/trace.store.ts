import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

export const TRACE_STORE = Symbol('TRACE_STORE');

export type TraceStatus = 'ok' | 'error' | 'aborted';

/** One completed model call. Token counts and cost never include message text. */
export interface LlmCallRecord {
  tier: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  /** Null when the model has no entry in the price table. */
  costUsd: number | null;
}

export interface TraceRecord {
  customerId: string;
  threadId: string;
  route: string | null;
  tools: string[];
  status: TraceStatus;
  latencyMs: number;
  calls: LlmCallRecord[];
}

/** Per-request traces: metadata only, no prompts, messages, tool arguments or results. */
export interface TraceStore {
  record(trace: TraceRecord): Promise<void>;
}

@Injectable()
export class PrismaTraceStore implements TraceStore {
  constructor(private readonly prisma: PrismaService) {}

  async record({ calls, ...trace }: TraceRecord): Promise<void> {
    // Nested create runs the trace and its calls in one transaction.
    await this.prisma.chatTrace.create({
      data: { ...trace, calls: { create: calls } },
    });
  }
}
