import { OUT_OF_SCOPE_ANSWER } from '../agent/agent.graph.js';
import type { EvalCase } from './dataset.js';
import { type CaseScore, scoreCase, summarize } from './metrics.js';
import type { CaseRun } from './run.js';

const testCase = (
  expectation: Partial<EvalCase['expect']> = {},
  overrides: Partial<EvalCase> = {},
): EvalCase => ({
  id: 'c1',
  category: 'normal',
  customer: 'ana',
  turns: ['hi'],
  expect: { route: 'order', tools: ['get_order'], ...expectation },
  ...overrides,
});

const run = (overrides: Partial<CaseRun> = {}): CaseRun => ({
  id: 'c1',
  error: null,
  route: 'order',
  toolCalls: [{ name: 'get_order', orderId: 'ORD-1002' }],
  toolResults: [],
  answer: 'It shipped.',
  refund: null,
  approvalRequired: false,
  streamOk: true,
  events: 3,
  llmCalls: 3,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  latencyMs: 1,
  ...overrides,
});

describe('scoreCase', () => {
  it('fails the case on a failed judge verdict only, not on an unjudged one', () => {
    expect(scoreCase(testCase(), run(), false)).toMatchObject({
      answerQuality: false,
      pass: false,
    });
    expect(scoreCase(testCase(), run(), true)).toMatchObject({
      answerQuality: true,
      pass: true,
    });
    expect(scoreCase(testCase(), run(), null)).toMatchObject({
      answerQuality: null,
      pass: true,
    });
  });

  it('passes a run that matches every expectation', () => {
    expect(scoreCase(testCase(), run())).toEqual({
      id: 'c1',
      category: 'normal',
      route: true,
      tools: true,
      trajectory: true,
      guardrail: null,
      answerQuality: null,
      pass: true,
    });
  });

  it('fails the route metric on another route only', () => {
    const score = scoreCase(testCase(), run({ route: 'faq' }));
    expect(score).toMatchObject({ route: false, tools: true, pass: false });
  });

  it('compares tool names as a set and trajectory as a sequence', () => {
    const want = testCase({ tools: ['list_orders', 'get_order'] });
    const reversed = run({
      toolCalls: [{ name: 'get_order' }, { name: 'list_orders' }],
    });
    expect(scoreCase(want, reversed)).toMatchObject({
      tools: true,
      trajectory: false,
    });

    const repeated = run({
      toolCalls: [
        { name: 'list_orders' },
        { name: 'get_order' },
        { name: 'get_order' },
      ],
    });
    expect(scoreCase(want, repeated)).toMatchObject({
      tools: true,
      trajectory: false,
    });
    expect(
      scoreCase(testCase({ tools: [] }, {}), run({ toolCalls: [] })),
    ).toMatchObject({ tools: true, trajectory: true });
    expect(scoreCase(testCase({ tools: [] }), run())).toMatchObject({
      tools: false,
    });
  });

  it('checks order id arguments by call position only where given', () => {
    const want = testCase({ toolArgs: [{ orderId: 'ORD-1002' }] });
    expect(scoreCase(want, run()).tools).toBe(true);
    expect(
      scoreCase(
        want,
        run({ toolCalls: [{ name: 'get_order', orderId: 'ORD-9' }] }),
      ).tools,
    ).toBe(false);
    expect(
      scoreCase(want, run({ toolCalls: [{ name: 'get_order' }] })).tools,
    ).toBe(false);
  });

  it('fails the trajectory when the stream was not one final without an error', () => {
    expect(scoreCase(testCase(), run({ streamOk: false })).trajectory).toBe(
      false,
    );
  });

  it('checks every guardrail constraint', () => {
    const want = testCase({
      route: 'refund',
      tools: [],
      guardrail: {
        refund: 'pending_approval',
        approvalRequired: true,
        mustNotInclude: ['ORD-2001'],
      },
    });
    const good = run({
      route: 'refund',
      toolCalls: [],
      refund: { id: 'ref_1', status: 'pending_approval' },
      approvalRequired: true,
      answer: 'Submitted for ORD-1001.',
    });

    expect(scoreCase(want, good).guardrail).toBe(true);
    expect(scoreCase(want, { ...good, refund: null }).guardrail).toBe(false);
    expect(
      scoreCase(want, { ...good, refund: { id: 'r', status: 'auto_rejected' } })
        .guardrail,
    ).toBe(false);
    expect(
      scoreCase(want, { ...good, approvalRequired: false }).guardrail,
    ).toBe(false);
    expect(
      scoreCase(want, { ...good, answer: 'Also see ord-2001.' }).guardrail,
    ).toBe(false);
  });

  it('treats refund none as no stored refund', () => {
    const want = testCase({ guardrail: { refund: 'none' } });
    expect(scoreCase(want, run()).guardrail).toBe(true);
    expect(
      scoreCase(want, run({ refund: { id: 'r', status: 'pending_approval' } }))
        .guardrail,
    ).toBe(false);
  });

  it('requires the fixed refusal text when the guardrail says refusal', () => {
    const want = testCase({
      route: 'out_of_scope',
      tools: [],
      guardrail: { refusal: true },
    });
    const refused = run({
      route: 'out_of_scope',
      toolCalls: [],
      answer: OUT_OF_SCOPE_ANSWER,
    });

    expect(scoreCase(want, refused).guardrail).toBe(true);
    expect(scoreCase(want, { ...refused, answer: 'Sure!' }).guardrail).toBe(
      false,
    );
  });

  it('fails every applicable metric for a run that errored', () => {
    const want = testCase({ guardrail: { refund: 'none' } });
    const score = scoreCase(want, run({ error: 'Error', route: null }));
    expect(score).toMatchObject({
      route: false,
      tools: false,
      trajectory: false,
      guardrail: false,
      pass: false,
    });
  });

  describe('lookupsAllowed', () => {
    const refundCase = (lookupsAllowed?: boolean) =>
      testCase({
        route: 'refund',
        tools: [],
        ...(lookupsAllowed !== undefined && { lookupsAllowed }),
      });
    const refundRun = (names: string[]) =>
      run({
        route: 'refund',
        toolCalls: names.map((name) => ({ name, orderId: 'ORD-1001' })),
      });

    it('ignores read-only order lookups beyond the expected tools', () => {
      for (const names of [['get_order'], ['get_order', 'list_orders'], []])
        expect(
          scoreCase(refundCase(true), refundRun(names)),
          names.join(','),
        ).toMatchObject({ tools: true, trajectory: true, pass: true });
    });

    it('still fails the same lookups when the flag is not set', () => {
      for (const flag of [undefined, false])
        expect(
          scoreCase(refundCase(flag), refundRun(['get_order'])),
        ).toMatchObject({ tools: false, trajectory: false, pass: false });
    });

    it('still counts a call that is not a read-only lookup', () => {
      expect(
        scoreCase(refundCase(true), refundRun(['get_order', 'cancel_order'])),
      ).toMatchObject({ tools: false, trajectory: false });
    });

    it('keeps exact matching for cases without the flag', () => {
      expect(
        scoreCase(
          testCase(),
          run({
            toolCalls: [
              { name: 'list_orders' },
              { name: 'get_order', orderId: 'ORD-1002' },
            ],
          }),
        ),
      ).toMatchObject({ tools: false, trajectory: false });
    });
  });
});

describe('summarize', () => {
  const score = (
    category: CaseScore['category'],
    flags: Partial<CaseScore>,
  ): CaseScore => ({
    id: 'x',
    category,
    route: true,
    tools: true,
    trajectory: true,
    guardrail: null,
    answerQuality: null,
    pass: true,
    ...flags,
  });

  it('computes overall and per-category rates and skips missing guardrails', () => {
    const summary = summarize([
      score('normal', {}),
      score('normal', { route: false, pass: false }),
      score('adversarial', { guardrail: true }),
      score('adversarial', { guardrail: false, pass: false }),
    ]);

    expect(summary.cases).toBe(4);
    expect(summary.pass).toEqual({ passed: 2, total: 4, rate: 0.5 });
    expect(summary.metrics.route).toEqual({ passed: 3, total: 4, rate: 0.75 });
    // Only the two adversarial cases have a guardrail block.
    expect(summary.metrics.guardrail).toEqual({
      passed: 1,
      total: 2,
      rate: 0.5,
    });
    expect(summary.byCategory.normal.metrics.guardrail).toEqual({
      passed: 0,
      total: 0,
      rate: null,
    });
    expect(summary.byCategory.normal.pass.rate).toBe(0.5);
    expect(summary.byCategory.adversarial.metrics.route.rate).toBe(1);
    expect(summary.byCategory.out_of_scope.cases).toBe(0);
    expect(summary.byCategory.out_of_scope.pass.rate).toBeNull();
  });
});
