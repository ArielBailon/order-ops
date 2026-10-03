import pg from 'pg';
import { z } from 'zod';
import {
  type ConversationRow,
  formatReport,
  type LatencyRow,
  type ModelRow,
} from './report.js';

const env = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);

const sinceIndex = process.argv.indexOf('--since');
const since =
  sinceIndex >= 0
    ? new Date(process.argv[sinceIndex + 1] ?? '')
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
if (Number.isNaN(since.getTime())) {
  console.error('--since must be a date such as 2026-10-01');
  process.exit(1);
}

const latencySql = (byRoute: boolean) => `
  SELECT ${byRoute ? 'route' : 'NULL::text AS route'},
         count(*)::int AS requests,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs")::float AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float AS p95
  FROM "ChatTrace" WHERE "createdAt" >= $1 ${byRoute ? 'GROUP BY route ORDER BY requests DESC' : ''}`;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
try {
  const overall = await pool.query<LatencyRow>(latencySql(false), [since]);
  const byRoute = await pool.query<LatencyRow>(latencySql(true), [since]);
  const conversations = await pool.query<ConversationRow>(
    `SELECT t."customerId" AS "customerId", t."threadId" AS "threadId",
            COALESCE(sum(c."costUsd"), 0)::float AS "costUsd",
            count(*) FILTER (WHERE c."costUsd" IS NULL)::int AS unpriced
     FROM "ChatTrace" t JOIN "LlmCall" c ON c."traceId" = t.id
     WHERE t."createdAt" >= $1 GROUP BY t."customerId", t."threadId"`,
    [since],
  );
  const models = await pool.query<ModelRow>(
    `SELECT c.provider, c.model, count(*)::int AS calls,
            sum(c."inputTokens")::int AS "inputTokens",
            sum(c."outputTokens")::int AS "outputTokens",
            sum(c."cacheReadTokens")::int AS "cacheReadTokens",
            COALESCE(sum(c."costUsd"), 0)::float AS "costUsd"
     FROM "LlmCall" c JOIN "ChatTrace" t ON t.id = c."traceId"
     WHERE t."createdAt" >= $1 GROUP BY c.provider, c.model
     ORDER BY "costUsd" DESC`,
    [since],
  );
  console.log(
    formatReport({
      since,
      overall: overall.rows[0] ?? null,
      byRoute: byRoute.rows,
      conversations: conversations.rows,
      models: models.rows,
    }),
  );
} finally {
  await pool.end();
}
