import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from './cli.js';
import { checkAll, checkRegression, main } from './regress.js';

const scores = (pass: boolean) => ({
  route: pass,
  tools: pass,
  trajectory: pass,
  guardrail: null,
  answerQuality: null as boolean | null,
  pass,
});

/** `outcomes` maps case id to pass; a string value is a run error. */
const result = (
  outcomes: Record<string, boolean | string>,
  overrides: Partial<ResultFile> = {},
): ResultFile =>
  ({
    provider: 'openai',
    runAt: '2026-10-03T10:00:00.000Z',
    datasetSha256: 'hash-1',
    cases: Object.entries(outcomes).map(([id, outcome]) => ({
      id,
      error: typeof outcome === 'string' ? outcome : null,
      scores: scores(outcome === true),
    })),
    ...overrides,
  }) as unknown as ResultFile;

const ten = (failing: string[] = []) =>
  Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`c${i}`, !failing.includes(`c${i}`)]),
  );

describe('checkRegression', () => {
  it('fails on a pass-rate drop beyond the tolerance and lists the regressed cases', () => {
    const report = checkRegression(result(ten()), result(ten(['c0', 'c1'])));
    expect(report.ok).toBe(false);
    expect(report.message).toContain('100.0% -> 80.0%');
    expect(report.message).toContain('passed before, fail now: c0, c1');
  });

  it('passes a drop within the tolerance but still lists the cases', () => {
    const report = checkRegression(result(ten()), result(ten(['c3'])));
    expect(report.ok).toBe(true);
    expect(report.message).toContain('within');
    expect(report.message).toContain('c3');
  });

  it('honors a custom tolerance', () => {
    const latest = result(ten(['c3']));
    expect(checkRegression(result(ten()), latest, 0.05).ok).toBe(false);
  });

  it('passes an improvement', () => {
    const report = checkRegression(result(ten(['c0'])), result(ten()));
    expect(report.ok).toBe(true);
    expect(report.message).not.toContain('passed before');
  });

  it('compares only the shared cases, so a partial run is not a regression', () => {
    const report = checkRegression(
      result(ten()),
      result({ c0: true, c1: true }),
    );
    expect(report.ok).toBe(true);
    expect(report.message).toContain('over 2 shared cases');
  });

  it('leaves out cases that errored on either side', () => {
    const report = checkRegression(
      result({ a: true, b: 'Error', c: true }),
      result({ a: true, b: true, c: 'AbortError' }),
    );
    expect(report.message).toContain('over 1 shared cases');
    expect(report.ok).toBe(true);
  });

  it('skips when nothing is shared', () => {
    const report = checkRegression(result({ a: true }), result({ b: false }));
    expect(report.ok).toBe(true);
    expect(report.message).toContain('skipped');
  });

  it('counts answer quality only when both runs were judged', () => {
    const judged = (quality: boolean | null): ResultFile => {
      const r = result({ a: true });
      r.cases[0].scores.answerQuality = quality;
      r.judge = { provider: 'anthropic', model: 'j', rubricVersion: 1 };
      return r;
    };
    const unjudged = result({ a: true });

    expect(checkRegression(judged(true), judged(false), 0).ok).toBe(false);
    expect(checkRegression(unjudged, judged(false), 0).ok).toBe(true);
  });
});

describe('checkAll', () => {
  it('skips with a notice when a provider has no earlier run on the same dataset', () => {
    const reports = checkAll([
      result(ten()),
      result(ten(), { provider: 'anthropic' }),
      result(ten(['c0', 'c1', 'c2']), {
        provider: 'anthropic',
        runAt: '2026-10-04T10:00:00.000Z',
        datasetSha256: 'hash-2',
      }),
    ]);
    expect(reports.map((r) => r.provider)).toEqual(['anthropic', 'openai']);
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(reports[0].message).toContain('no earlier run on this dataset');
  });

  it('compares the newest run with the newest earlier run of the same dataset', () => {
    const reports = checkAll([
      result(ten(), { runAt: '2026-10-01T00:00:00.000Z' }),
      result(ten(['c0']), { runAt: '2026-10-02T00:00:00.000Z' }),
      result(ten(['c0', 'c1', 'c2']), { runAt: '2026-10-03T00:00:00.000Z' }),
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toContain('90.0% -> 70.0%');
    expect(reports[0].ok).toBe(false);
  });
});

describe('main', () => {
  const folder = async (...files: ResultFile[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'regress-'));
    for (const [i, file] of files.entries())
      await writeFile(join(dir, `${i}.json`), JSON.stringify(file));
    return dir;
  };

  it('exits 0 with a notice for an empty or missing folder', async () => {
    expect(await main([], await folder())).toBe(0);
    expect(await main([], join(tmpdir(), 'no-such-regress-folder'))).toBe(0);
  });

  it('exits 1 on a regression and 0 without one', async () => {
    const before = result(ten(), { runAt: '2026-10-01T00:00:00.000Z' });
    const worse = result(ten(['c0', 'c1', 'c2']));
    expect(await main([], await folder(before, worse))).toBe(1);
    expect(await main([], await folder(before, before))).toBe(0);
    expect(
      await main(['--tolerance', '0.5'], await folder(before, worse)),
    ).toBe(0);
  });

  it('rejects a bad tolerance', async () => {
    for (const bad of ['', 'x', '-1', '2'])
      expect(await main(['--tolerance', bad], await folder())).toBe(1);
  });
});
