import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { RunnableLambda } from '@langchain/core/runnables';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_IDS } from '../models/providers.js';
import {
  buildResult,
  CliError,
  formatSummary,
  judgeRuns,
  main,
  parseCliArgs,
  readGitSha,
  requireCredentials,
  resultFileName,
  selectCases,
  writeResult,
} from './cli.js';
import { type EvalCase, loadDataset } from './dataset.js';
import type { CaseRun } from './run.js';

describe('parseCliArgs', () => {
  it('requires a known provider', () => {
    expect(() => parseCliArgs([])).toThrow(CliError);
    expect(() => parseCliArgs(['--provider', 'gemini'])).toThrow(
      /--provider is required/,
    );
    expect(parseCliArgs(['--provider', 'openai'])).toEqual({
      provider: 'openai',
    });
  });

  it('parses ids, category and limit and rejects bad values', () => {
    expect(
      parseCliArgs([
        '--provider',
        'anthropic',
        '--ids',
        'a,b',
        '--category',
        'adversarial',
        '--limit',
        '3',
      ]),
    ).toEqual({
      provider: 'anthropic',
      ids: ['a', 'b'],
      category: 'adversarial',
      limit: 3,
    });
    const bad = (extra: string[]) =>
      expect(() => parseCliArgs(['--provider', 'openai', ...extra])).toThrow(
        CliError,
      );
    bad(['--category', 'nope']);
    bad(['--limit', '0']);
    bad(['--limit', 'x']);
    bad(['--unknown', '1']);
  });

  it('parses --judge and --judge-provider, which needs --judge', () => {
    expect(parseCliArgs(['--provider', 'openai', '--judge'])).toEqual({
      provider: 'openai',
      judge: true,
    });
    expect(
      parseCliArgs([
        '--provider',
        'openai',
        '--judge',
        '--judge-provider',
        'bedrock',
      ]),
    ).toEqual({ provider: 'openai', judge: true, judgeProvider: 'bedrock' });
    expect(() =>
      parseCliArgs(['--provider', 'openai', '--judge-provider', 'bedrock']),
    ).toThrow(/needs --judge/);
    expect(() =>
      parseCliArgs([
        '--provider',
        'openai',
        '--judge',
        '--judge-provider',
        'x',
      ]),
    ).toThrow(CliError);
  });
});

describe('selectCases', () => {
  const cases = (['normal', 'normal', 'out_of_scope'] as const).map(
    (category, i) =>
      ({
        id: `c${i}`,
        category,
        customer: 'ana',
        turns: ['hi'],
        expect: { route: 'faq', tools: [] },
      }) satisfies EvalCase,
  );

  it('filters by id and category, then limits', () => {
    expect(selectCases(cases, { ids: ['c2', 'c0'] }).map((c) => c.id)).toEqual([
      'c0',
      'c2',
    ]);
    expect(selectCases(cases, { category: 'normal' })).toHaveLength(2);
    expect(selectCases(cases, { category: 'normal', limit: 1 })).toHaveLength(
      1,
    );
  });

  it('rejects unknown ids and an empty selection', () => {
    expect(() => selectCases(cases, { ids: ['nope'] })).toThrow(
      /Unknown case id: nope/,
    );
    expect(() => selectCases(cases, { category: 'adversarial' })).toThrow(
      /No cases match/,
    );
  });
});

describe('requireCredentials', () => {
  it('stops before any case when the provider credential is missing', () => {
    expect(() => requireCredentials('anthropic', {})).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => requireCredentials('bedrock', {})).toThrow(/AWS_REGION/);
    expect(() =>
      requireCredentials('openai', { OPENAI_API_KEY: 'k' }),
    ).not.toThrow();
  });

  it('fails main before reading the dataset or running anything', async () => {
    await expect(main(['--provider', 'openai'], {})).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('fails before any case when the judge provider has no credential', async () => {
    await expect(
      main(['--provider', 'openai', '--judge'], { OPENAI_API_KEY: 'k' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('results file', () => {
  const run = (overrides: Partial<CaseRun> = {}): CaseRun => ({
    id: 'normal-01',
    error: null,
    route: 'order',
    toolCalls: [{ name: 'get_order', orderId: 'ORD-1002' }],
    toolResults: ['{"id":"ORD-1002"}'],
    answer: 'It shipped.',
    refund: null,
    approvalRequired: false,
    streamOk: true,
    events: 4,
    llmCalls: 3,
    inputTokens: 300,
    outputTokens: 30,
    cachedTokens: 100,
    costUsd: 0.01,
    latencyMs: 900,
    ...overrides,
  });

  it('has the documented shape with the dataset hash and git sha filled', async () => {
    const { cases, sha256 } = await loadDataset();
    const selected = cases.slice(0, 2);
    const result = buildResult({
      runAt: new Date('2026-10-03T17:05:06.789Z'),
      gitSha: readGitSha(),
      datasetSha256: sha256,
      provider: 'openai',
      cases: selected,
      runs: [
        run({ id: selected[0].id }),
        run({ id: selected[1].id, error: 'Error', route: null, costUsd: null }),
      ],
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      runAt: '2026-10-03T17:05:06.789Z',
      datasetSha256: sha256,
      provider: 'openai',
      models: MODEL_IDS.openai,
      summary: {
        cases: 2,
        errors: 1,
        inputTokens: 600,
        outputTokens: 60,
        cachedTokens: 200,
        costUsd: null,
      },
    });
    expect(result.gitSha).toMatch(/^([0-9a-f]{4,40}|unknown)$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toEqual({
      id: selected[0].id,
      category: selected[0].category,
      scores: expect.objectContaining({ pass: expect.any(Boolean) }),
      error: null,
      route: 'order',
      tools: ['get_order'],
      answer: 'It shipped.',
      events: 4,
      inputTokens: 300,
      outputTokens: 30,
      cachedTokens: 100,
      costUsd: 0.01,
      latencyMs: 900,
    });
    expect(formatSummary(result)).toContain('provider openai');
  });

  it('writes <UTC timestamp>-<provider>.json without colons', async () => {
    const { cases, sha256 } = await loadDataset();
    const result = buildResult({
      runAt: new Date('2026-10-03T17:05:06.789Z'),
      gitSha: 'abc1234',
      datasetSha256: sha256,
      provider: 'anthropic',
      cases: cases.slice(0, 1),
      runs: [run({ id: cases[0].id })],
    });
    expect(resultFileName(result)).toBe(
      '2026-10-03T17-05-06.789Z-anthropic.json',
    );

    const dir = await mkdtemp(join(tmpdir(), 'eval-results-'));
    const path = await writeResult(join(dir, 'nested'), result);

    expect(path).toBe(
      join(dir, 'nested', '2026-10-03T17-05-06.789Z-anthropic.json'),
    );
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(result)),
    );
  });

  it('has no judge fields without --judge and records them with it', async () => {
    const { cases, sha256 } = await loadDataset();
    const selected = cases.slice(0, 2);
    const base = {
      runAt: new Date('2026-10-03T17:05:06.789Z'),
      gitSha: 'abc1234',
      datasetSha256: sha256,
      provider: 'openai' as const,
      cases: selected,
      runs: selected.map((c) => run({ id: c.id })),
    };

    const plain = buildResult(base);
    expect(plain).not.toHaveProperty('judge');
    expect(plain.summary).not.toHaveProperty('judgeCostUsd');
    expect(plain.cases[0].scores.answerQuality).toBeNull();
    expect(plain.summary.metrics.answerQuality.total).toBe(0);

    const outcome = (pass: boolean | null, costUsd: number | null) => ({
      verdict: null,
      pass,
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    });
    const judged = buildResult({
      ...base,
      judged: {
        provider: 'anthropic',
        outcomes: [outcome(true, 0.5), outcome(false, 0.25)],
      },
    });
    expect(judged.judge).toEqual({
      provider: 'anthropic',
      model: MODEL_IDS.anthropic.strong,
      rubricVersion: 1,
    });
    expect(judged.summary.judgeCostUsd).toBe(0.75);
    expect(judged.summary.costUsd).toBe(0.02);
    expect(judged.cases.map((c) => c.scores.answerQuality)).toEqual([
      true,
      false,
    ]);
    expect(judged.summary.metrics.answerQuality).toMatchObject({
      passed: 1,
      total: 2,
    });
    expect(formatSummary(judged)).toContain('judge anthropic');
  });
});

describe('judgeRuns', () => {
  it('judges finished cases with their tool results and skips failed runs', async () => {
    const { cases } = await loadDataset();
    const selected = cases.slice(0, 2);
    const seen: string[] = [];
    const model = {
      withStructuredOutput: () =>
        RunnableLambda.from(async (messages: { content: unknown }[]) => {
          seen.push(String(messages[1].content));
          return { relevant: true, grounded: true, appropriate: true };
        }),
    } as unknown as BaseChatModel;
    const finished = {
      id: selected[0].id,
      error: null,
      route: 'order',
      toolCalls: [],
      toolResults: ['{"id":"ORD-1002"}'],
      answer: 'It shipped.',
    } as unknown as CaseRun;
    const failed = { ...finished, id: selected[1].id, error: 'Error' };

    const outcomes = await judgeRuns(selected, [finished, failed], model);

    expect(outcomes[0]).toMatchObject({ pass: true });
    expect(outcomes[1]).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('{"id":"ORD-1002"}');
    expect(seen[0]).toContain(selected[0].turns[0]);
  });
});
