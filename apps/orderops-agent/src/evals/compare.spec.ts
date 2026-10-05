import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from './cli.js';
import { buildComparison, latestPerProvider, main } from './compare.js';

const rate = (passed: number, total: number) => ({
  passed,
  total,
  rate: total ? passed / total : null,
});

const result = (overrides: Partial<ResultFile> = {}): ResultFile =>
  ({
    schemaVersion: 1,
    runAt: '2026-10-03T10:00:00.000Z',
    gitSha: 'abc1234',
    datasetSha256: 'hash-1',
    provider: 'openai',
    models: { cheap: 'cheap-m', strong: 'strong-m' },
    summary: {
      cases: 2,
      pass: rate(1, 2),
      metrics: {
        route: rate(2, 2),
        tools: rate(2, 2),
        trajectory: rate(2, 2),
        guardrail: rate(0, 0),
        answerQuality: rate(0, 0),
      },
      costUsd: 0.5,
    },
    cases: [{ latencyMs: 100 }, { latencyMs: 300 }],
    ...overrides,
  }) as unknown as ResultFile;

describe('latestPerProvider', () => {
  it('keeps the newest run of each provider', () => {
    const rows = latestPerProvider([
      result({ runAt: '2026-10-01T00:00:00.000Z', gitSha: 'old' }),
      result({ runAt: '2026-10-03T00:00:00.000Z', gitSha: 'new' }),
      result({ provider: 'anthropic' }),
    ]);
    expect(rows.map((r) => `${r.provider}:${r.gitSha}`)).toEqual([
      'anthropic:abc1234',
      'openai:new',
    ]);
  });
});

describe('buildComparison', () => {
  it('says so when there are no results', () => {
    expect(buildComparison([])).toBe('No eval results found.\n');
  });

  it('renders a row per provider with rates, cost and median latency', () => {
    const table = buildComparison([result()]);
    expect(table).toContain(
      '| openai | cheap-m / strong-m | 2 | 50% | 100% | 100% | 100% | n/a | n/a | $0.5000 | 200 ms | 2026-10-03 @ abc1234 |',
    );
    expect(table).not.toContain('Not comparable');
  });

  it('shows answer quality and treats files without the metric as n/a', () => {
    const judged = result({ provider: 'anthropic' });
    judged.summary.metrics.answerQuality = rate(3, 4);
    judged.judge = { provider: 'openai', model: 'j', rubricVersion: 1 };
    const legacy = result();
    delete (legacy.summary.metrics as Partial<typeof legacy.summary.metrics>)
      .answerQuality;

    const table = buildComparison([judged, legacy]);
    expect(table).toContain('75%');
    expect(table).toContain('Not comparable on answer quality');
  });

  it('flags runs on different dataset versions', () => {
    const table = buildComparison([
      result(),
      result({ provider: 'anthropic', datasetSha256: 'hash-2' }),
    ]);
    expect(table).toContain('different dataset versions');
  });
});

describe('main', () => {
  it('prints a clear message and writes nothing without results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compare-'));
    const out = join(dir, 'COMPARISON.md');
    expect(await main(join(dir, 'missing'), out)).toBe(
      'No eval results found.\n',
    );
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });

  it('writes the table for the results in the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'compare-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify(result()));
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const out = join(dir, 'COMPARISON.md');

    const table = await main(dir, out);

    expect(await readFile(out, 'utf8')).toBe(table);
    expect(table).toContain('| openai |');
  });
});
