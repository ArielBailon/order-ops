import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import type { ChatRoute } from '../chat/chat.schemas.js';
import {
  conversations,
  latency,
  models,
  type QueryRunner,
  rateCounts,
  share,
  type TraceWindow,
} from '../trace/trace-metrics.js';
import type { TraceStatus } from '../trace/trace.store.js';
import type {
  SummaryResponse,
  TraceDetail,
  TraceListItem,
  TraceListQuery,
  TraceListResponse,
} from './observability.schemas.js';

export const OBSERVABILITY_STORE = Symbol('OBSERVABILITY_STORE');

/** Read-only queries over `ChatTrace` and `LlmCall`: metadata only, never message text. */
export interface ObservabilityStore {
  summary(since: Date, now: Date): Promise<SummaryResponse>;
  /** Null when `before` names a trace that does not exist. */
  listTraces(query: TraceListQuery): Promise<TraceListResponse | null>;
  getTrace(id: string): Promise<TraceDetail | null>;
}

type Cost = number | string | { toString(): string } | null;

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Sum of the priced costs as a six-decimal string, null when none had a price. */
export function sumCost(costs: Cost[]): string | null {
  const priced = costs.filter((c): c is Exclude<Cost, null> => c !== null);
  if (priced.length === 0) return null;
  // Whole micro-dollars avoid float drift; the column holds six decimals.
  const micros = priced.reduce<number>(
    (total, c) => total + Math.round(Number(c.toString()) * 1e6),
    0,
  );
  return (micros / 1e6).toFixed(6);
}

/** Builds the summary from the shared trace metrics. */
export async function buildSummary(
  query: QueryRunner,
  window: TraceWindow,
  now: Date,
): Promise<SummaryResponse> {
  const [[overall], byRoute, convs, modelRows, counts] = await Promise.all([
    latency(query, window, false),
    latency(query, window, true),
    conversations(query, window),
    models(query, window),
    rateCounts(query, window),
  ]);
  const costs = convs.map((c) => c.costUsd);
  const total = costs.reduce((sum, c) => sum + c, 0);
  const input = modelRows.reduce((sum, m) => sum + m.inputTokens, 0);
  const cached = modelRows.reduce((sum, m) => sum + m.cacheReadTokens, 0);
  return {
    since: window.since.toISOString(),
    until: now.toISOString(),
    requests: counts.requests,
    errorRate: share(counts.errors, counts.requests),
    failoverRate: share(counts.failovers, counts.requests),
    overall:
      overall && overall.requests > 0
        ? { requests: overall.requests, p50: overall.p50, p95: overall.p95 }
        : null,
    byRoute: byRoute.map(({ route, requests, p50, p95 }) => ({
      route,
      requests,
      p50,
      p95,
    })),
    conversations: {
      count: convs.length,
      totalUsd: round6(total),
      averageUsd: round6(convs.length ? total / convs.length : 0),
      maxUsd: round6(costs.reduce((m, c) => Math.max(m, c), 0)),
      unpriced: convs.reduce((sum, c) => sum + c.unpriced, 0),
    },
    models: modelRows.map((m) => ({ ...m, costUsd: round6(m.costUsd) })),
    cachedShare: share(cached, input),
  };
}

interface TraceRow {
  id: string;
  createdAt: Date;
  customerId: string;
  threadId: string;
  route: string | null;
  tools: string[];
  status: TraceStatus;
  latencyMs: number;
  failovers: number;
}

export function toListItem(
  trace: TraceRow,
  calls: { costUsd: Cost }[],
): TraceListItem {
  return {
    id: trace.id,
    createdAt: trace.createdAt.toISOString(),
    customerId: trace.customerId,
    threadId: trace.threadId,
    route: trace.route as ChatRoute | null,
    tools: trace.tools,
    status: trace.status,
    latencyMs: trace.latencyMs,
    failovers: trace.failovers,
    calls: calls.length,
    costUsd: sumCost(calls.map((c) => c.costUsd)),
  };
}

@Injectable()
export class PrismaObservabilityStore implements ObservabilityStore {
  constructor(private readonly prisma: PrismaService) {}

  summary(since: Date, now: Date): Promise<SummaryResponse> {
    // Positional parameters are bound by the driver, never spliced into the SQL.
    const query: QueryRunner = (sql, params) =>
      this.prisma.$queryRawUnsafe(sql, ...params);
    return buildSummary(query, { since }, now);
  }

  async listTraces({
    since,
    until,
    route,
    status,
    limit,
    before,
  }: TraceListQuery): Promise<TraceListResponse | null> {
    let cursor: { createdAt: Date; id: string } | null = null;
    if (before) {
      cursor = await this.prisma.chatTrace.findUnique({
        where: { id: before },
        select: { createdAt: true, id: true },
      });
      if (!cursor) return null;
    }
    const rows = await this.prisma.chatTrace.findMany({
      where: {
        ...(since || until
          ? {
              createdAt: {
                ...(since && { gte: since }),
                ...(until && { lt: until }),
              },
            }
          : {}),
        ...(route && { route }),
        ...(status && { status }),
        ...(cursor && {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row tells whether another page exists.
      take: limit + 1,
      include: { calls: { select: { costUsd: true } } },
    });
    const page = rows.slice(0, limit);
    return {
      traces: page.map(({ calls, ...trace }) => toListItem(trace, calls)),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async getTrace(id: string): Promise<TraceDetail | null> {
    const trace = await this.prisma.chatTrace.findUnique({
      where: { id },
      // Call order: `seq` is the position in the request. Calls stored before it existed all have
      // seq 0 and one timestamp, so their order is stable but not the call order.
      include: {
        calls: {
          orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!trace) return null;
    const { calls, ...rest } = trace;
    const item = toListItem(rest, calls);
    return {
      ...item,
      calls: calls.map((c) => ({
        tier: c.tier,
        provider: c.provider,
        model: c.model,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        latencyMs: c.latencyMs,
        costUsd: sumCost([c.costUsd]),
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }
}
