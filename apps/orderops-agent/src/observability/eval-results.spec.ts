import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from '../evals/cli.js';
import { latestEvals } from './eval-results.js';

const run = (provider: string, runAt: string, dataset = 'hash-a'): ResultFile =>
  ({
    schemaVersion: 1,
    runAt,
    gitSha: 'abc123',
    datasetSha256: dataset,
    provider,
    models: { cheap: 'c', strong: 's' },
    summary: { cases: 2, errors: 0 },
    cases: [
      { id: 'n1', answer: 'secret model answer' },
      { id: 'n2', answer: 'another answer' },
    ],
  }) as unknown as ResultFile;

async function dirWith(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-results-'));
  for (const [name, body] of Object.entries(files))
    await writeFile(join(dir, name), body, 'utf8');
  return dir;
}

describe('latestEvals', () => {
  it('keeps the newest run per provider, sorted by provider, without cases', async () => {
    const dir = await dirWith({
      'old-openai.json': JSON.stringify(run('openai', '2026-10-01T00:00:00Z')),
      'new-openai.json': JSON.stringify(run('openai', '2026-10-05T00:00:00Z')),
      'anthropic.json': JSON.stringify(
        run('anthropic', '2026-10-03T00:00:00Z'),
      ),
      'notes.txt': 'not a result',
    });

    const latest = await latestEvals(dir);

    expect(latest.providers.map((p) => [p.provider, p.runAt])).toEqual([
      ['anthropic', '2026-10-03T00:00:00Z'],
      ['openai', '2026-10-05T00:00:00Z'],
    ]);
    expect(latest.providers[0]).toMatchObject({ caseCount: 2, judge: null });
    expect(latest.providers[0]).not.toHaveProperty('cases');
    expect(JSON.stringify(latest)).not.toContain('secret model answer');
    expect(latest.comparable).toBe(true);
  });

  it('flags runs on different datasets as not comparable', async () => {
    const dir = await dirWith({
      'a.json': JSON.stringify(
        run('anthropic', '2026-10-03T00:00:00Z', 'hash-a'),
      ),
      'b.json': JSON.stringify(run('openai', '2026-10-03T00:00:00Z', 'hash-b')),
    });

    expect((await latestEvals(dir)).comparable).toBe(false);
  });

  it('returns no providers for an empty or missing directory', async () => {
    await expect(latestEvals(await dirWith({}))).resolves.toEqual({
      providers: [],
      comparable: true,
    });
    await expect(
      latestEvals(join(tmpdir(), 'no-such-eval-dir-xyz')),
    ).resolves.toEqual({
      providers: [],
      comparable: true,
    });
  });

  it('fails on a malformed result file instead of skipping it', async () => {
    const dir = await dirWith({ 'broken.json': '{ not json' });

    await expect(latestEvals(dir)).rejects.toThrow(SyntaxError);
  });
});
