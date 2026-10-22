import { z } from 'zod';
import { chatRouteSchema, type ChatRoute } from '../chat/chat.schemas.js';
import type { ModelRow } from '../trace/report.js';
import type { TraceStatus } from '../trace/trace.store.js';

/** An ISO 8601 date-time (with offset) or a plain date, as a Date. */
const isoDate = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value));

export const summaryQuerySchema = z.object({ since: isoDate.optional() });
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

export const traceListQuerySchema = z.object({
  since: isoDate.optional(),
  until: isoDate.optional(),
  route: chatRouteSchema.optional(),
  status: z.enum(['ok', 'error', 'aborted']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.uuid().optional(),
});
export type TraceListQuery = z.infer<typeof traceListQuerySchema>;

export const traceIdSchema = z.uuid();

export interface LatencyStats {
  requests: number;
  p50: number;
  p95: number;
}

/** Report data as JSON. Money values are USD estimates rounded to six decimals. */
export interface SummaryResponse {
  since: string;
  until: string;
  requests: number;
  errorRate: number;
  failoverRate: number;
  overall: LatencyStats | null;
  byRoute: (LatencyStats & { route: string | null })[];
  conversations: {
    count: number;
    totalUsd: number;
    averageUsd: number;
    maxUsd: number;
    unpriced: number;
  };
  models: ModelRow[];
  cachedShare: number;
}

export interface TraceListItem {
  id: string;
  createdAt: string;
  customerId: string;
  threadId: string;
  route: ChatRoute | null;
  tools: string[];
  status: TraceStatus;
  latencyMs: number;
  failovers: number;
  /** Number of completed model calls. */
  calls: number;
  /** Six-decimal sum of the priced calls, null when none had a price. */
  costUsd: string | null;
}

export interface TraceListResponse {
  traces: TraceListItem[];
  /** Pass as `before` to get the next page; null on the last page. */
  nextBefore: string | null;
}

export interface TraceCallDetail {
  tier: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: string | null;
  createdAt: string;
}

export type TraceDetail = Omit<TraceListItem, 'calls'> & {
  calls: TraceCallDetail[];
};
