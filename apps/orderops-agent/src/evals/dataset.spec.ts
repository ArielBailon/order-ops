import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateRefund, toCents } from '../refunds/refund-rules.js';
import { loadDataset } from './dataset.js';
import { NOW, ORDERS } from './fixtures.js';

const ORDER_ID = /ORD-\d+/g;

describe('eval dataset', () => {
  it('validates and has enough cases per category', async () => {
    const { cases, sha256 } = await loadDataset();
    const count = (category: string) =>
      cases.filter((c) => c.category === category).length;

    expect(count('normal')).toBeGreaterThanOrEqual(18);
    expect(count('out_of_scope')).toBeGreaterThanOrEqual(6);
    expect(count('adversarial')).toBeGreaterThanOrEqual(10);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('only names fixture orders in refund targets and mustNotInclude', async () => {
    const { cases } = await loadDataset();
    const known = new Set(ORDERS.map((o) => o.id));
    for (const { id, expect: want } of cases) {
      const named = [
        ...(want.guardrail?.mustNotInclude ?? []).flatMap(
          (s) => s.match(ORDER_ID) ?? [],
        ),
        ...(want.guardrail?.refundTarget
          ? [want.guardrail.refundTarget.orderId]
          : []),
      ];
      for (const orderId of named)
        expect(known.has(orderId), `${id}: ${orderId}`).toBe(true);
    }
  });

  it('keeps stored refund expectations consistent with the refund rules', async () => {
    const { cases } = await loadDataset();
    const stored = cases.filter(({ expect: want }) =>
      ['pending_approval', 'auto_rejected'].includes(
        want.guardrail?.refund ?? 'none',
      ),
    );
    expect(stored.length).toBeGreaterThan(0);

    for (const { id, customer, turns, expect: want } of stored) {
      const target = want.guardrail?.refundTarget;
      expect(target, `${id} needs a refundTarget`).toBeDefined();
      const order = ORDERS.find((o) => o.id === target?.orderId);
      expect(order, `${id}: unknown order`).toBeDefined();
      if (!order || !target) continue;
      expect(order.customerId, `${id}: not the caller order`).toBe(
        `cus_${customer}`,
      );
      const verdict = evaluateRefund({
        order,
        amountCents: toCents(target.amount ?? order.total),
        openRequestExists: false,
        now: NOW,
      });
      expect(verdict.ok ? 'pending_approval' : 'auto_rejected', id).toBe(
        want.guardrail?.refund,
      );
      // A later turn can reuse the open request from an earlier one, which streams no approval.
      if (turns.length === 1)
        expect(want.guardrail?.approvalRequired, id).toBe(verdict.ok);
    }
  });

  it('rejects an unknown field, a duplicate id and a bad route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dataset-'));
    const base = {
      id: 'x',
      category: 'normal',
      customer: 'ana',
      turns: ['hi'],
      expect: { route: 'faq', tools: [] },
    };
    const write = async (name: string, data: unknown) => {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(data));
      return path;
    };

    await expect(
      loadDataset(await write('dup.json', [base, base])),
    ).rejects.toThrow(/Duplicate eval case id: x/);
    await expect(
      loadDataset(await write('extra.json', [{ ...base, extra: 1 }])),
    ).rejects.toThrow();
    await expect(
      loadDataset(
        await write('route.json', [
          { ...base, expect: { route: 'nope', tools: [] } },
        ]),
      ),
    ).rejects.toThrow();
  });
});
