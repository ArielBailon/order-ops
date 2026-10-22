import type { ConversationRow, LatencyRow, ModelRow } from './report.js';

/**
 * Runs one SQL statement with positional parameters (`$1`, `$2`, ...) and returns its rows.
 * The CLI passes a `pg` pool and the API passes Prisma's raw query; values are always bound.
 */
export type QueryRunner = <T>(sql: string, params: unknown[]) => Promise<T[]>;

/** `since` inclusive, `until` exclusive; no `until` means up to now. */
export interface TraceWindow {
  since: Date;
  until?: Date;
}

export interface RateCounts {
  requests: number;
  errors: number;
  failovers: number;
}

/** The time filter on `ChatTrace` for a column prefix (`""` or `t.`), with its bound values. */
function windowSql(window: TraceWindow, column: string) {
  const params: unknown[] = [window.since];
  let sql = `${column}"createdAt" >= $1`;
  if (window.until) {
    params.push(window.until);
    sql += ` AND ${column}"createdAt" < $2`;
  }
  return { sql, params };
}

export async function latency(
  query: QueryRunner,
  window: TraceWindow,
  byRoute: boolean,
): Promise<LatencyRow[]> {
  const where = windowSql(window, '');
  return query<LatencyRow>(
    `
  SELECT ${byRoute ? 'route' : 'NULL::text AS route'},
         count(*)::int AS requests,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs")::float AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float AS p95
  FROM "ChatTrace" WHERE ${where.sql} ${byRoute ? 'GROUP BY route ORDER BY requests DESC' : ''}`,
    where.params,
  );
}

export async function conversations(
  query: QueryRunner,
  window: TraceWindow,
): Promise<ConversationRow[]> {
  const where = windowSql(window, 't.');
  return query<ConversationRow>(
    `SELECT t."customerId" AS "customerId", t."threadId" AS "threadId",
            COALESCE(sum(c."costUsd"), 0)::float AS "costUsd",
            count(*) FILTER (WHERE c."costUsd" IS NULL)::int AS unpriced
     FROM "ChatTrace" t JOIN "LlmCall" c ON c."traceId" = t.id
     WHERE ${where.sql} GROUP BY t."customerId", t."threadId"`,
    where.params,
  );
}

export async function models(
  query: QueryRunner,
  window: TraceWindow,
): Promise<ModelRow[]> {
  const where = windowSql(window, 't.');
  return query<ModelRow>(
    `SELECT c.provider, c.model, count(*)::int AS calls,
            sum(c."inputTokens")::int AS "inputTokens",
            sum(c."outputTokens")::int AS "outputTokens",
            sum(c."cacheReadTokens")::int AS "cacheReadTokens",
            COALESCE(sum(c."costUsd"), 0)::float AS "costUsd"
     FROM "LlmCall" c JOIN "ChatTrace" t ON t.id = c."traceId"
     WHERE ${where.sql} GROUP BY c.provider, c.model
     ORDER BY "costUsd" DESC`,
    where.params,
  );
}

/** Counts behind the error rate (`status = 'error'`) and failover rate (`failovers > 0`). */
export async function rateCounts(
  query: QueryRunner,
  window: TraceWindow,
): Promise<RateCounts> {
  const where = windowSql(window, '');
  const [row] = await query<RateCounts>(
    `SELECT count(*)::int AS requests,
            count(*) FILTER (WHERE status = 'error')::int AS errors,
            count(*) FILTER (WHERE failovers > 0)::int AS failovers
     FROM "ChatTrace" WHERE ${where.sql}`,
    where.params,
  );
  return row ?? { requests: 0, errors: 0, failovers: 0 };
}

/** A share in [0, 1]; 0 when there is nothing to divide by. */
export const share = (part: number, whole: number) =>
  whole > 0 ? part / whole : 0;
