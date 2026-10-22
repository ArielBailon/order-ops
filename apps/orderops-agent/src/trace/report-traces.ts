import pg from 'pg';
import { z } from 'zod';
import { formatReport } from './report.js';
import {
  conversations,
  latency,
  models,
  type QueryRunner,
} from './trace-metrics.js';

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

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const query: QueryRunner = async (sql, params) =>
  (await pool.query(sql, params)).rows;
try {
  const window = { since };
  const [overall] = await latency(query, window, false);
  console.log(
    formatReport({
      since,
      overall: overall ?? null,
      byRoute: await latency(query, window, true),
      conversations: await conversations(query, window),
      models: await models(query, window),
    }),
  );
} finally {
  await pool.end();
}
